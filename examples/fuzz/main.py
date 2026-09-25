#!/usr/bin/env python3
"""Fuzzing bot: plays badly on purpose, to find what the engine and the host do
about it.

Three jobs, in order of how much they hurt:

1. Load. It splits at every opportunity, so a match drives the unit count to
   `UNIT_LIMIT` and the host ends up shepherding as many live interpreters as
   the map allows. That is the lag test.
2. Protocol. It emits malformed lines, duplicate commands, near-misses on the
   ENDTURN sentinel and out-of-range arguments, then usually a valid action
   after them. Last-wins means the dragon survives while every rejection path in
   ReadReply gets walked.
3. Turn failure. It times out and it crashes, on purpose, at a set rate -- half
   the time having already printed a usable move, half the time having printed
   nothing. That is the difference between a dragon that lives and one that dies
   of `NoValidAction`, so both sides get exercised every run.

It also touches every reader on the helper API once a turn, so a change that
breaks parsing shows up here rather than in someone's contest bot.

Every decision comes from a seeded RNG keyed on (seed, dragon id, round), so a
run is reproducible from the seed printed in the first LOG line, and a dragon
that is restarted mid-match does not replay the same decision forever -- the
round has moved on.

    FUZZ_SEED=12345 unswbc run maps/small.map examples/fuzz examples/fuzz

Rates are tunable, as fractions of a turn:

    FUZZ_SEED            base seed                          (default 1337)
    FUZZ_TIMEOUT_VALID   hang, having printed a good move   (default 0.05)
    FUZZ_TIMEOUT_SILENT  hang, having printed nothing       (default 0.05)
    FUZZ_CRASH           exit mid-turn, no ENDTURN          (default 0.02)
    FUZZ_JUNK            emit malformed lines this turn     (default 0.35)
    FUZZ_SUICIDE         choose a move known to be fatal    (default 0.01)
    FUZZ_POISON          override a good action with a bad one (default 0.03)
    FUZZ_SAFE_FLOOR      units held back from fatal plans   (default 4)
    FUZZ_HOST_PROBE      rounds between host probes, 0 for none
                         (default 16, and only where the clock is virtual)

Where the host keeps a virtual clock -- the judge charges a nanosecond per CPU
point and does not really sleep -- a hang cannot end a turn, so the two timeout
plans burn points instead. The host checks run every turn either way and stay
silent unless one fails, so a correct host leaves the replay unchanged.

The three fatal rates (silent timeout, poison, suicide) are scaled by how many
units the team has to spare, so a match always reaches its round limit instead
of dying out in the first few dozen rounds. On a map with sparse pearls that
damping is the difference between 30 rounds and 500.
"""

import os
import random
import sys
import time

import helper as unswbc
from helper import Direction, Position

ct: unswbc.Controller
game: unswbc.Game

UINT32_MAX = 2**32 - 1
MIN_SIZE = unswbc.Constants.MIN_SIZE


def rate(name: str, fallback: float) -> float:
    try:
        return max(0.0, min(1.0, float(os.environ.get(name, fallback))))
    except ValueError:
        return fallback


SEED = int(os.environ.get("FUZZ_SEED", 1337))
_probe = os.environ.get("FUZZ_HOST_PROBE")
PROBE_EVERY = int(_probe) if _probe else 16
PROBE_ANYWHERE = _probe is not None

WRITE_SYSCALL_COST = 2_500_000
WRITE_BYTE_COST = 4_000
TIMEOUT_VALID = rate("FUZZ_TIMEOUT_VALID", 0.05)
TIMEOUT_SILENT = rate("FUZZ_TIMEOUT_SILENT", 0.05)
CRASH = rate("FUZZ_CRASH", 0.02)
JUNK = rate("FUZZ_JUNK", 0.35)
SUICIDE = rate("FUZZ_SUICIDE", 0.01)
POISON = rate("FUZZ_POISON", 0.03)

# Units held back from the fatal plans: a wiped-out team ends the run early.
SAFE_FLOOR = int(os.environ.get("FUZZ_SAFE_FLOOR", 4))

# Long enough for the host to kill it first. A first turn gets the warmup
# budget, so clear both.
HANG_SECONDS = max(
    int(os.environ.get("UNSWBC_TURN_MS", 5)),
    int(os.environ.get("UNSWBC_WARMUP_MS", 200)),
) / 1000.0 * 3 + 1

last_monotonic = 0
host_entropy = b""

# Rounds this process has seen. A restart resets it; the engine's count carries on.
rounds_here = 0
first_round_seen: int | None = None

# Malformed lines: ReadReply must refuse each one. A bare "ENDTURN" would end
# the turn, so it is deliberately absent.
JUNK_LINES = [
    "",                        # blank: skipped before the keyword is read
    "   ",                     # whitespace only: same
    "MOVE",                    # no argument
    "MOVE X",                  # not a direction
    "MOVE NNXE",               # one bad letter poisons the whole step list
    "MOVE N EXTRA",            # trailing junk after a good direction
    "MOVE 1",                  # digits where letters go
    "SPLIT",                   # no argument
    "SPLIT abc",               # not a number
    "SPLIT -1",                # negative
    "SPLIT 0",                 # below MIN_SIZE
    "SPLIT 99999",             # longer than any dragon
    "SPLIT 2 2",               # trailing argument
    "SONAR",                   # no argument
    "SONAR -5",                # negative, against %u
    "SONAR 4294967296",        # one past uint32
    "SONAR 12 34",             # trailing argument
    "DOT 1",                   # too few arguments
    "DOT 1 2 999 999 999",     # colours past 255, against %hhu
    "LINE 1 2 3",              # too few arguments
    "FLARP 1 2 3",             # unknown keyword
    "ENDTURNX",                # near-miss on the sentinel
    "endturn",                 # wrong case, so not the sentinel either
    "A" * 40 + " 1",           # keyword longer than the 15-char buffer
]


# Lines ReadReply accepts and the engine then refuses. These parse, so they
# overwrite the action slot, which is why they are sent last.
POISON_LINES = [
    ("SPLIT 0", "split a child below MIN_SIZE"),
    ("SPLIT 1", "split a child of one segment"),
    ("SPLIT -3", "split a negative child"),
    ("SPLIT 99999", "split off more than the dragon has"),
    ("MOVE NNNNNNNN", "more steps than a short dragon can pay for"),
]


def emit(line: str) -> None:
    """Write a raw protocol line, bypassing the helper's validation. The helper
    is doing its job when it refuses to send these, which is exactly why the
    engine's own refusals need testing from underneath it."""
    print(line, flush=True)


def virtual_clock() -> bool:
    """Every clock the judge answers reads the same counter -- the CPU points
    spent -- so monotonic and process time sit a few reads apart. A real host
    measures one since boot and the other since exec, which are nothing alike."""
    return abs(time.monotonic_ns() - time.process_time_ns()) < 10_000_000


def burn(nanos: int) -> int:
    """Spend the budget rather than wait for it. On a virtual clock the reading
    is the points spent, so this is the only way a turn can run out."""
    deadline = time.monotonic_ns() + nanos
    total = 0
    while time.monotonic_ns() < deadline:
        total += sum(i * i for i in range(2048))
    return total


def stall(seconds: float) -> None:
    if virtual_clock():
        burn(int(seconds * 1e9))
    else:
        time.sleep(seconds)


def host_probe(round_num: int) -> None:
    """What the host looks like from in here, now and then. Only where the clock
    is virtual, because that is where the numbers are reproducible and so worth
    comparing against the judge -- and where a replay stays byte-identical."""
    if PROBE_EVERY <= 0 or round_num % PROBE_EVERY:
        return
    virtual = virtual_clock()
    if not virtual and not PROBE_ANYWHERE:
        return

    line = (f"host round={round_num} clock={'virtual' if virtual else 'real'} "
            f"mono={time.monotonic_ns()} cpu={time.process_time_ns()} "
            f"epoch={time.time():.6f} rand={host_entropy[:8].hex()}")
    before = time.monotonic_ns()
    ct.output_log(line)
    charged = time.monotonic_ns() - before

    owed = WRITE_SYSCALL_COST + WRITE_BYTE_COST * (len(line) + len("LOG ") + 1)
    if virtual and charged < owed:
        ct.output_log(f"host-violation: a {len(line)}B log cost {charged}, judge charges {owed}+")


def host_checks() -> None:
    """Invariants every host owes a bot. Silent when they hold, so a good host
    leaves the replay byte-identical."""
    global last_monotonic, host_entropy

    now = time.monotonic_ns()
    if now < last_monotonic:
        ct.output_log(f"host-violation: monotonic went back {last_monotonic} -> {now}")

    before = time.monotonic_ns()
    sum(i * i for i in range(4096))
    if time.monotonic_ns() <= before:
        ct.output_log("host-violation: work did not move the clock")

    before = time.monotonic_ns()
    time.sleep(0.001)
    if time.monotonic_ns() - before < 1_000_000:
        ct.output_log("host-violation: sleep did not move the clock")

    drawn = os.urandom(16)
    if drawn == host_entropy:
        ct.output_log("host-violation: random_get repeated itself")
    if len(set(drawn)) == 1:
        ct.output_log(f"host-violation: random_get returned {drawn[:1].hex()} x16")
    host_entropy = drawn

    last_monotonic = time.monotonic_ns()


def turn_rng() -> random.Random:
    """Reproducible per (seed, dragon, round). Keyed on the engine's round rather
    than a local counter, so a restarted process carries on from where the match
    is rather than repeating the decision that killed it."""
    key = f"{SEED}:{ct.get_id()}:{game.get_round_num()}"
    if virtual_clock():
        key += f":{host_entropy.hex()}"
    return random.Random(key)


def key(pos: Position) -> tuple[int, int]:
    return (pos.x, pos.y)


def step(pos: Position, direction: Direction) -> Position:
    """Wrapped by the board, so passing `game` here is also what covers the
    wrapping path in Position.add_dir."""
    return pos.add_dir(direction, game)


def survey() -> dict:
    """Read everything the API offers, once a turn. Nothing here influences
    play: it is here so a parsing regression in the helper surfaces as a
    traceback in a fuzz run instead of quietly in a contest."""
    vision = ct.get_vision()
    here = ct.get_position()
    facing = ct.get_dir()

    for direction in Direction.get_direction_list():
        direction.get_offset()
        direction.get_opposite()
        direction.get_left()
        direction.get_right()

    ct.get_team().get_enemy_team()

    width, height = game.get_map_size()
    game.get_unit_limit()
    game.get_round_num()

    pearls: list[Position] = []
    dragons: list[Position] = []
    portals: list[tuple[Position, Direction, int]] = []
    blocked: set[tuple[tuple[int, int], str]] = set()

    for tile in vision.get_tiles():
        position = tile.position
        tile.pearl_time
        entity = tile.entity
        if isinstance(entity, unswbc.Pearl):
            entity.get_position()
            pearls.append(position)
        elif isinstance(entity, unswbc.DragonPart):
            entity.get_position()
            entity.get_id()
            entity.get_team()
            entity.get_dir()
            if entity.get_id() != ct.get_id():
                dragons.append(position)
            entity.is_head()

        for direction in Direction.get_direction_list():
            edge = tile.get_edge(direction)
            if edge is None:
                continue
            edge.is_horizontal
            edge.edge_type
            edge.get_portal_id()
            if not edge.is_passable():
                blocked.add((key(position), direction.value))
            elif edge.is_portal():
                portals.append((position, direction, edge.get_portal_id()))

    vision.get_tile(here)
    vision.get_tile(step(here, facing))

    return {
        "here": here,
        "facing": facing,
        "size": (width, height),
        "pearls": pearls,
        "dragons": dragons,
        "portals": portals,
        "blocked": blocked,
        "head": ct.get_head(),
    }


def legal_steps(world: dict) -> list[Direction]:
    """Steps that are not into known kelp, a visible dragon, or our own neck."""
    here = world["here"]
    reverse = world["facing"].get_opposite()
    out = []
    for direction in Direction.get_direction_list():
        if direction == reverse:
            continue
        if (key(here), direction.value) in world["blocked"]:
            continue
        if key(step(here, direction)) in {key(p) for p in world["dragons"]}:
            continue
        out.append(direction)
    return out


def fatal_steps(world: dict) -> list[Direction]:
    """Steps known to kill: into kelp, into a visible dragon, or into our own
    neck. Used rarely and on purpose, so HitWall, HitOtherBody, HitHeadToHead
    and HitSelf all get reached over a long run."""
    legal = set(legal_steps(world))
    return [d for d in Direction.get_direction_list() if d not in legal]


def toroidal_gap(a: int, b: int, size: int) -> int:
    offset = (b - a) % size
    return min(offset, size - offset)


def toward(world: dict, target: Position) -> Direction | None:
    """The legal step that most reduces wrapped distance to `target`."""
    width, height = world["size"]
    here = world["here"]
    best = None
    best_gap = None
    for direction in legal_steps(world):
        ahead = step(here, direction)
        gap = toroidal_gap(ahead.x, target.x, width) + toroidal_gap(ahead.y, target.y, height)
        if best_gap is None or gap < best_gap:
            best, best_gap = direction, gap
    return best


def split_size(rng: random.Random) -> int | None:
    """A child size the controller will accept, chosen across the whole legal
    range rather than always the same half, so Split's boundary checks see more
    than one shape. None when this dragon is too short to divide."""
    length = ct.get_length()
    sizes = [n for n in range(MIN_SIZE, length - MIN_SIZE + 1) if ct.can_split(n)]
    if not sizes:
        return None
    # Bias to the extremes, where Split's own checks sit.
    if rng.random() < 0.5:
        return rng.choice([sizes[0], sizes[-1]])
    return rng.choice(sizes)


def spray_junk(rng: random.Random) -> None:
    """Malformed lines, and a carriage return, before the real action. Every one
    should be refused and logged rather than obeyed."""
    for line in rng.sample(JUNK_LINES, rng.randint(1, 4)):
        emit(line)
    if rng.random() < 0.3:
        # Windows text mode: the trailing CR must be stripped, not parsed.
        emit(f"MOVE {rng.choice(list(Direction)).value}\r")


def decorate(rng: random.Random, world: dict) -> None:
    """Every debug and drawing command, plus sonar. These are append-only: they
    never override the action, so they are safe to fire at any volume."""
    here = world["here"]

    if world["pearls"]:
        target = rng.choice(world["pearls"])
        ct.draw_indicator_dot(target, 255, 210, 90)
    if rng.random() < 0.5:
        ct.draw_indicator_line(here, step(here, world["facing"]), 120, 190, 255)
    if rng.random() < 0.2:
        ct.draw_indicator_dot(here, 0, 0, 0)
        ct.draw_indicator_dot(here, 255, 255, 255)

    ct.set_indicator_string(
        f"id {ct.get_id()} len {ct.get_length()} units {ct.get_unit_count()}/{game.get_unit_limit()}"
    )

    inbox = ct.get_sonar_messages()
    if inbox:
        ct.output_log(f"sonar in: {inbox[:4]}")
    ct.send_sonar(rng.choice([0, 1, ct.get_length(), rng.randint(0, UINT32_MAX), UINT32_MAX]))


def fatal_budget() -> float:
    """How freely this dragon may do something that kills it, from 0 to 1. Scaled
    by the team's headroom over SAFE_FLOOR, which needs no coordination between
    dragons: each reads the same UNIT_COUNT and throttles itself by the same
    amount, so the population settles rather than collapsing."""
    units = ct.get_unit_count()
    if units <= SAFE_FLOOR:
        return 0.0
    limit = max(game.get_unit_limit(), SAFE_FLOOR + 1)
    return min(1.0, (units - SAFE_FLOOR) / (limit - SAFE_FLOOR))


def cautious_step(world: dict) -> Direction | None:
    """The legal step with the most room behind it, by one-step lookahead. Used
    when the team cannot afford a careless death. Not pathfinding -- just enough
    to stop a dragon walking into a pocket it could see."""
    legal = legal_steps(world)
    if not legal:
        return None

    taken = {key(p) for p in world["dragons"]}

    def room(direction: Direction) -> int:
        ahead = step(world["here"], direction)
        out = 0
        for onward in Direction.get_direction_list():
            if (key(ahead), onward.value) in world["blocked"]:
                continue
            if key(step(ahead, onward)) in taken:
                continue
            out += 1
        return out

    return max(legal, key=room)


def choose_plan(rng: random.Random, world: dict) -> tuple[str, str]:
    """Pick this turn's headline action, as (plan, why). Ordered so the failure
    modes get their share before the ordinary play does. The fatal ones are
    rationed by the team's headroom; the survivable ones are not."""
    roll = rng.random()
    spare = fatal_budget()

    if roll < TIMEOUT_SILENT * spare:
        return "timeout-silent", "hang with nothing printed, so the dragon should die"
    roll -= TIMEOUT_SILENT * spare

    if roll < TIMEOUT_VALID:
        return "timeout-valid", "print a good move, then hang, so the move should stand"
    roll -= TIMEOUT_VALID

    if roll < CRASH:
        return "crash", "print a good move, then exit before ENDTURN"
    roll -= CRASH

    if roll < SUICIDE * spare and fatal_steps(world):
        return "suicide", "step somewhere known to be fatal"
    roll -= SUICIDE * spare

    if roll < POISON * spare:
        return "poison", "print a good move, then override it with a bad one"

    if ct.get_unit_count() < game.get_unit_limit() and split_size(rng) is not None:
        return "split", "grow the unit count toward the limit"

    if not legal_steps(world):
        return "boxed", "no legal step left"

    if world["pearls"]:
        return "eat", "close on a pearl to get long enough to split"

    if world["portals"] and rng.random() < 0.25:
        return "portal", "take a portal to cover the wrapping paths"

    # Each extra step costs a segment, so only sprint well clear of split length.
    if ct.get_length() >= 2 * MIN_SIZE + 3 and rng.random() < 0.25:
        return "sprint", "multi-step move, which pays a segment per extra step"

    return "wander", "no pearl in sight"


def act(plan: str, rng: random.Random, world: dict) -> None:
    """Carry out the plan. The intent line has already been logged."""
    legal = legal_steps(world)
    fallback = legal[0] if legal else world["facing"]

    if plan == "timeout-silent":
        stall(HANG_SECONDS)
        return

    if plan == "timeout-valid":
        ct.make_move(rng.choice(legal) if legal else fallback)
        stall(HANG_SECONDS)
        return

    if plan == "crash":
        ct.make_move(rng.choice(legal) if legal else fallback)
        sys.stdout.flush()
        os._exit(7)

    if plan == "suicide":
        ct.make_move(rng.choice(fatal_steps(world)))
        return

    if plan == "poison":
        ct.make_move(rng.choice(legal) if legal else fallback)
        # A valid SPLIT past the unit limit, or an out-of-range shape.
        if rng.random() < 0.3:
            line, why = f"SPLIT {max(MIN_SIZE, ct.get_length() // 2)}", "split past the unit limit"
        else:
            line, why = rng.choice(POISON_LINES)
        ct.output_log(f"poisoning with {line!r}: {why}")
        emit(line)
        return

    if plan == "split":
        size = split_size(rng)
        if size is not None and ct.do_split(size):
            return
        ct.make_move(fallback)
        return

    if plan == "eat":
        direction = toward(world, rng.choice(world["pearls"]))
        ct.make_move(direction or fallback)
        return

    if plan == "portal":
        position, direction, _ = rng.choice(world["portals"])
        if key(position) == key(world["here"]) and direction in legal:
            ct.make_move(direction)
        else:
            ct.make_move(toward(world, position) or fallback)
        return

    if plan == "sprint":
        steps = [rng.choice(legal)] * rng.randint(2, min(3, ct.get_length() - 1))
        if not ct.make_moves(steps):
            ct.make_move(fallback)
        return

    if plan == "boxed":
        ct.make_move(world["facing"])
        return

    # wander: random with units to spare, roomiest step down at the floor.
    if fatal_budget() == 0.0:
        ct.make_move(cautious_step(world) or fallback)
        return

    ct.make_move(rng.choice(legal) if legal else fallback)


def execute_turn() -> None:
    global rounds_here, first_round_seen

    rounds_here += 1
    round_num = game.get_round_num()
    if first_round_seen is None:
        first_round_seen = round_num
        ct.output_log(
            f"fuzz seed={SEED} id={ct.get_id()} team={ct.get_team().value} "
            f"joined at round {round_num}"
        )
        if round_num > 0:
            ct.output_log(f"no memory of rounds before {round_num}")

    host_checks()
    host_probe(round_num)

    rng = turn_rng()
    world = survey()

    plan, why = choose_plan(rng, world)

    # Intent first, always. LOG is emitted by the engine as it parses, so this
    # line survives even when the turn is about to time out or crash -- which is
    # the only way to tell a deliberate failure here from a real one.
    ct.output_log(f"round {round_num} plan={plan} :: {why}")

    if rng.random() < JUNK:
        spray_junk(rng)

    # Drawing and sonar never override the action, so they go before it and
    # cannot spoil a plan that is about to hang.
    decorate(rng, world)

    act(plan, rng, world)

    # A second action after the first, now and then: last-wins means this one
    # is what the engine should obey.
    if plan in {"eat", "wander", "sprint"} and rng.random() < 0.15:
        again = rng.choice(legal_steps(world) or [world["facing"]])
        ct.output_log(f"overriding with {again.value}, which should win")
        ct.make_move(again)


def main() -> None:
    global ct, game
    ct, game = unswbc.init()

    while unswbc.update(ct, game):
        execute_turn()
        unswbc.end_turn()


if __name__ == "__main__":
    main()
