"""`unswbc run`: build two bots and battle them on a map."""

from __future__ import annotations

import pathlib
import sys
import time

from . import clangtool, color, toolchain
from .bot import ZYGOTE, Bot, Pool
from .engine import DEBUG_ALL, EngineModule
from .errors import UserError, fail
from .project import NoBotfile, Project, ProjectError

MAX_ROUNDS = 500
# The wasm shim reports each team's total length, not its longest dragon, so a
# game that went the distance can only say that length decided it.
END_REASONS = {0: "by elimination", 1: "on length"}
DRAW_REASONS = {0: "both teams eliminated", 1: "equal length"}
DEATH_REASONS = {
    "W": "hit a wall", "S": "hit itself", "O": "hit another dragon",
    "H": "lost a head-to-head", "A": "no valid action",
}


class RunError(UserError):
    pass


def _inspect(path: pathlib.Path) -> tuple[list[str], pathlib.Path, str] | None:
    if path.is_file():
        if path.suffix == ".py":
            return (toolchain.find_python() + [ZYGOTE, str(path.resolve())], path.parent, "python")
        if path.suffix == ".wasm":
            return ([str(path.resolve())], path.parent, "wasm")
        if toolchain.is_executable(path):
            return ([str(path.resolve())], path.parent, "c/c++")
        return None
    if not path.is_dir():
        return None
    for name in (toolchain.BOT_NAME, toolchain.BOT_NAME + ".exe"):
        binary = path / name
        if toolchain.is_executable(binary):
            return ([str(binary.resolve())], path, "c/c++")
    script = path / "main.py"
    if script.is_file():
        return (toolchain.find_python() + [ZYGOTE, str(script.resolve())], path, "python")
    module = path / "main.wasm"
    if module.is_file():
        return ([str(module.resolve())], path, "wasm")
    return None


def _resolve(arg: str, sandbox: bool = False) -> tuple[list[str], pathlib.Path, str]:
    path = pathlib.Path(arg)
    if not path.exists():
        raise RunError(f"not found: {arg}")

    if sandbox and path.is_dir() and not (path / "main.py").is_file():
        if clangtool.sources(path):
            return ([str(clangtool.build(path))], path, "wasm")

    if path.is_file():
        found = _inspect(path)
        if found is None:
            raise RunError(f"{arg}: not a runnable bot")
        return found

    try:
        built = Project.from_dir(arg).compile()
    except NoBotfile:
        built = None
    except ProjectError as error:
        raise RunError(f"{arg}: {error}") from error

    found = _inspect(built) if built is not None else _inspect(path)
    if found is None:
        raise RunError(f"{arg}: not a runnable bot")
    return found


def _elapsed(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds) // 60}m{int(seconds) % 60:02d}s"


def _round_ms(seconds: float) -> str:
    return f"{int(seconds * 1000)}ms" if seconds < 1 else f"{seconds:.1f}s"


def _points(value: int) -> str:
    return f"{value / 1e6:.1f}M" if value >= 100_000 else f"{value:,}"


def _percentile(ordered: list[int], q: int) -> int:
    return ordered[max(0, -(-q * len(ordered) // 100) - 1)]


class Progress:
    def __init__(self, verbose: bool = False) -> None:
        self.verbose = verbose
        self.interactive = sys.stdout.isatty() and not verbose
        self.round = 0
        self.start = time.monotonic()
        self.round_start = self.start
        self.last = 0.0
        self.width = 0

    def clear(self) -> None:
        if self.width:
            print("\r" + " " * self.width + "\r", end="", flush=True)
            self.width = 0

    def update(self, round_num: int, dragons: tuple[int, int]) -> None:
        if round_num == self.round:
            return
        now = time.monotonic()
        self.last = now - self.round_start
        self.round_start = now
        self.round = round_num

        eta = (now - self.start) / round_num * (MAX_ROUNDS - round_num) if round_num else 0.0
        text = (f"running round {round_num + 1}/{MAX_ROUNDS} --  last: {_round_ms(self.last)}"
                f"  eta: {_elapsed(eta)}  dragons: {dragons[0]} vs {dragons[1]}")
        if self.interactive:
            self.clear()
            print(text, end="", flush=True)
            self.width = len(text)
        elif self.verbose or round_num == 1 or round_num % 50 == 0 or round_num == MAX_ROUNDS:
            print(text, flush=True)


def _label(arg: str) -> str:
    name = pathlib.Path(arg).name
    if name in ("", ".", ".."):
        cwd = pathlib.Path.cwd()
        name = (cwd.parent if name == ".." else cwd).name
    return name or "bot"


def _default_replay_path(map_arg: str, bot_a: str, bot_b: str) -> pathlib.Path:
    map_name = pathlib.Path(map_arg).stem or "map"
    label_a = _label(bot_a)
    label_b = _label(bot_b)
    matchup = f"{label_a}-vs-itself" if label_a == label_b else f"{label_a}-vs-{label_b}"
    stamp = time.strftime("%Y-%m-%d-%H%M%S")
    return pathlib.Path(f"{matchup}-on-{map_name}-{stamp}.replay")


def execute(map_arg: str, bots: list[str], verbose: bool, replay_path, no_replay: bool,
            sandbox: bool = False, debug: int = DEBUG_ALL) -> int:
    pool_type, bot_type, sandbox_error = Pool, Bot, ()
    if sandbox:
        from .sandbox import (SandboxBot, SandboxError, SandboxPool, WasmPool,
                              warm_interpreter)

        pool_type, bot_type, sandbox_error = SandboxPool, SandboxBot, (SandboxError,)

    map_path = pathlib.Path(map_arg)
    if not map_path.is_file():
        return fail(f"not found: {map_arg}")

    if len(bots) != 2:
        return fail("run takes a map and two bots, "
                    "e.g. `unswbc run maps/arena.map mybot mybot`")
    names = bots
    try:
        argv_a, dir_a, kind_a = _resolve(names[0], sandbox)
        argv_b, dir_b, kind_b = ((argv_a, dir_a, kind_a) if names[1] == names[0]
                                 else _resolve(names[1], sandbox))
    except (RunError, ProjectError, clangtool.BuildError, toolchain.ToolError) as error:
        return fail(str(error))

    kinds = {kind_a, kind_b}
    if sandbox and not kinds <= {"python", "wasm"}:
        return fail("--sandbox runs python, C, C++ and wasm bots only")
    if not sandbox and "wasm" in kinds:
        return fail("a .wasm bot runs only with --sandbox")
    print(f"loaded {kind_a} vs {kind_b}" + (" in the judge's sandbox" if sandbox else ""))
    if sandbox and "python" in kinds:
        warm_interpreter()

    pools: dict[str, object] = {}
    try:
        for team, argv, botdir, kind in (("A", argv_a, dir_a, kind_a), ("B", argv_b, dir_b, kind_b)):
            maker = WasmPool if kind == "wasm" else pool_type
            pools[team] = maker(argv, cwd=str(botdir), team=team.lower())
    except (*sandbox_error, OSError) as error:
        for pool in pools.values():
            pool.close()
        return fail(str(error))
    live: dict[int, Bot] = {}
    teams: dict[int, str] = {}
    spent: dict[str, list[int]] = {}
    engine = EngineModule()
    progress = Progress(verbose)
    notices: list[str] = []
    started = progress.start

    def notice(line: str) -> None:
        notices.append(line)
        if verbose:
            progress.clear()
            print(color.paint(line, "yellow"), flush=True)

    def summarise() -> None:
        if notices and not verbose:
            print(color.paint(f"map: {len(notices)} defect{'' if len(notices) == 1 else 's'} found and "
                              "corrected -- rerun with -v to see them", "yellow"))

    def spawn(dragon_id: int, init: bytes) -> None:
        team = next(
            (l.split()[1] for l in init.decode().splitlines() if l.startswith("TEAM")), "A"
        )
        teams[dragon_id] = team
        live[dragon_id] = bot_type(pools[team], init=init, name=str(dragon_id))

    def who(dragon_id: int, block: bytes) -> str:
        head = block.split(b"\n", 1)[0].split()
        round_num = head[1].decode() if len(head) > 1 and head[0] == b"ROUND" else "?"
        return f"round {round_num}: bot {dragon_id} (team {teams.get(dragon_id, '?')})"

    def reply(dragon_id: int, block: bytes) -> bytes:
        head = block.split(b"\n", 1)[0].split()
        if len(head) > 1 and head[0] == b"ROUND":
            alive = [0, 0]
            for other in live:
                alive[teams.get(other, "A") == "B"] += 1
            progress.update(int(head[1]), (alive[0], alive[1]))
        bot = live[dragon_id]
        out = bot.ask(block)
        if bot.error is not None:
            progress.clear()
            print(color.paint(f"{who(dragon_id, block)} {bot.error}", "yellow"))
        if verbose and out:
            progress.clear()
            print(f"{who(dragon_id, block)} stdout:\n{out.decode(errors='replace')}")
        metrics = getattr(bot, "live", None)
        if metrics and metrics[0]:
            spent.setdefault(teams.get(dragon_id, "?"), []).append(metrics[0])
            if verbose:
                progress.clear()
                print(f"{who(dragon_id, block)} points {metrics[0]} memory {metrics[1]}")
        noise = bot.take_stderr() if verbose else b""
        if noise:
            progress.clear()
            print(f"{who(dragon_id, block)} stderr:\n{noise.decode(errors='replace')}")
        return out

    def death(dragon_id: int, round_num: int, reason: str) -> None:
        progress.clear()
        team = teams.get(dragon_id, "?")
        print(f"round {round_num}: bot {dragon_id} (team {team}) died: "
              f"{DEATH_REASONS.get(reason, 'died')}")
        bot = live.pop(dragon_id, None)
        if bot is not None:
            bot.stop()

    try:
        result = engine.run(map_path.read_bytes(), reply, death, spawn, notice, debug)
    except RuntimeError as error:
        summarise()
        return fail(f"{map_arg}: {error}")
    finally:
        for bot in live.values():
            bot.stop()
        for pool in pools.values():
            pool.close()

    progress.clear()
    summarise()
    rounds = result.rounds + 1
    reasons = DRAW_REASONS if result.winner is None else END_REASONS
    reason = reasons.get(result.end_reason, "over")
    took = _elapsed(time.monotonic() - started)
    if result.winner is None:
        print(color.paint(f"draw after {rounds} rounds ({reason}) ({took})", "green"))
    else:
        print(color.paint(f"team {result.winner} wins after {rounds} rounds ({reason}) ({took})", "green"))

    for team, turns in sorted(spent.items()):
        ordered = sorted(turns)
        print(f"team {team} points per turn: p50 {_points(_percentile(ordered, 50))}"
              f"  p99 {_points(_percentile(ordered, 99))}"
              f"  mean {_points(sum(ordered) // len(ordered))}"
              f"  max {_points(ordered[-1])}  ({len(ordered)} turns)")

    if no_replay:
        print("skipped writing replay")
        return 0

    path = pathlib.Path(replay_path) if replay_path else pathlib.Path("replays")
    if path.is_dir() or not path.suffix:
        path = path / _default_replay_path(map_arg, names[0], names[1])
    blob = engine.replay(names[0], names[1])
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
    except OSError as error:
        return fail(f"cannot write the replay to {path}: {error}")
    print(color.paint(f"wrote replay: {path}", "green"))
    return 0
