#!/usr/bin/env python3
"""Reference bot: hunts pearls, remembers the map, explores what it has not seen.

Each dragon is one process for its whole life, so everything it learns simply
lives in memory between rounds: which tiles it has seen, where the kelp is,
and where it last saw a pearl. That memory is what lets it path beyond its
7x7 window instead of wandering.

Cells are stored as one int, `y * width + x`, and an edge as `cell * 4 + d`
where `d` indexes DIRECTIONS. Ints hash and compare far faster than Position
objects, which matters because a turn runs one search over the whole map.
"""

import helper as unswbc
from helper import Direction, Position

ct: unswbc.Controller
game: unswbc.Game

SPLIT_AT_LENGTH = 6
SPRINT_AT_LENGTH = 5
PEARL_COLOUR = (255, 210, 90)
FRONTIER_COLOUR = (120, 190, 255)

DIRECTIONS = Direction.get_direction_list()

width = 0
height = 0
# steps(cell)[d] is the cell one step in DIRECTIONS[d], wrapping at the edges.
# Filled in as cells are reached: a whole 64x64 table up front would not fit
# in one turn's budget.
neighbours: list[tuple[int, ...] | None] = []

# Remembered across rounds.
seen: set[int] = set()
kelp: set[int] = set()
portals: set[int] = set()
# Kelp and portals both stop a walk: what lies beyond a portal is unknown.
walls: set[int] = set()
pearls: set[int] = set()
taken_portals: set[int] = set()

# Rebuilt every round from vision.
dragons: set[int] = set()
portal_cells: set[int] = set()


def setup() -> None:
    global width, height, neighbours
    width, height = game.get_map_size()
    neighbours = [None] * (width * height)


def around(cell: int) -> tuple[int, int, int, int]:
    """Neighbours in DIRECTIONS order: north, east, south, west."""
    n = width * height
    x = cell % width
    return (
        cell - width if cell >= width else cell - width + n,
        cell + 1 if x + 1 < width else cell + 1 - width,
        cell + width if cell < n - width else cell + width - n,
        cell - 1 if x else cell - 1 + width,
    )


def steps(cell: int) -> tuple[int, ...]:
    cached = neighbours[cell]
    if cached is None:
        neighbours[cell] = cached = around(cell)
    return cached


TABLE_CELLS_PER_TURN = 256
table_filled = 0


def fill_table() -> None:
    """A slice of the table each turn, so no one turn pays for all of it."""
    global table_filled
    end = min(table_filled + TABLE_CELLS_PER_TURN, len(neighbours))
    for cell in range(table_filled, end):
        if neighbours[cell] is None:
            neighbours[cell] = around(cell)
    table_filled = end


def cell_of(pos: Position) -> int:
    return pos.y * width + pos.x


def observe() -> None:
    """Fold this round's vision into the remembered map."""
    dragons.clear()
    for tile in ct.get_vision().get_tiles():
        cell = cell_of(tile.position)
        seen.add(cell)

        # A tile in view settles whether it holds a pearl, so stale memory of
        # one that has since been eaten is dropped here.
        if isinstance(tile.entity, unswbc.Pearl):
            pearls.add(cell)
        else:
            pearls.discard(cell)
            if isinstance(tile.entity, unswbc.DragonPart):
                dragons.add(cell)

        for d, direction in enumerate(DIRECTIONS):
            edge = tile.get_edge(direction)
            if edge is None:
                continue
            side = cell * 4 + d
            if not edge.is_passable():
                back = steps(cell)[d] * 4 + (d + 2) % 4
                kelp.add(side)
                kelp.add(back)
                walls.add(side)
                walls.add(back)
            elif edge.is_portal():
                portals.add(side)
                walls.add(side)

    portal_cells.clear()
    portal_cells.update(side >> 2 for side in portals - taken_portals)


def untaken_portal(cell: int) -> int | None:
    """A portal on this cell we have never gone through. Since what lies beyond
    is unknown until it is taken, an unused one is the cheapest route to a part
    of the map no amount of walking will reach."""
    for d in range(4):
        side = cell * 4 + d
        if side in portals and side not in taken_portals:
            return d
    return None


def search(start: int) -> tuple[int | None, int | None, list[int]]:
    """One breadth-first pass from the head over the remembered map. Unseen
    edges are assumed open: the plan is redone every round, so guessing wrong
    only costs one step.

    Returns the first step toward the nearest pearl, the first step toward the
    nearest frontier (unseen water or an unused portal), and how many cells
    each first step reaches before the others do. The pass stops as soon as
    the answer cannot change, so the room counts are only complete when both
    steps come back empty."""
    first = [-1] * len(neighbours)
    first[start] = 4
    queue = []
    room = [0, 0, 0, 0]
    frontier = None

    for d, nxt in enumerate(steps(start)):
        if first[nxt] < 0 and start * 4 + d not in walls and nxt not in dragons:
            first[nxt] = d
            queue.append(nxt)

    # The loop sees cells appended while it runs, which makes the list a queue.
    for cell in queue:
        step = first[cell]
        room[step] += 1
        if cell in pearls:
            return step, frontier, room
        if frontier is None and (cell not in seen or cell in portal_cells):
            frontier = step
            if not pearls:
                return None, frontier, room

        base = cell * 4
        for d, nxt in enumerate(steps(cell)):
            if first[nxt] < 0 and base + d not in walls and nxt not in dragons:
                first[nxt] = step
                queue.append(nxt)

    return None, frontier, room


def legal_steps(here: int) -> list[int]:
    """Steps that are not into kelp, a visible dragon, or our own neck. The neck
    can sit across a portal and out of sight, so facing is the only guide."""
    reverse = (DIRECTIONS.index(ct.get_dir()) + 2) % 4
    return [
        d
        for d, nxt in enumerate(steps(here))
        if d != reverse and here * 4 + d not in kelp and nxt not in dragons
    ]


def choose(here: int) -> tuple[int, str]:
    """A known pearl if there is one, else the nearest frontier, else room."""
    legal = legal_steps(here)
    if not legal:
        return DIRECTIONS.index(ct.get_dir()), "boxed in"

    pearl, frontier, room = search(here)
    if pearl in legal:
        return pearl, "pearl"

    # Standing on an unused portal already, so go through it.
    d = untaken_portal(here)
    if d in legal:
        taken_portals.add(here * 4 + d)
        return d, "through a portal"

    # Walking to a portal is how the dragon reaches the parts of the map that
    # no amount of walking would, so it counts as frontier alongside unseen water.
    if frontier in legal:
        return frontier, "exploring"

    return max(legal, key=room.__getitem__), "open water"


def execute_turn() -> None:
    fill_table()
    observe()
    length = ct.get_length()

    if length >= SPLIT_AT_LENGTH and ct.do_split(length // 2):
        ct.output_log(f"split at length {length}")
        ct.send_sonar(length)
        return

    here = cell_of(ct.get_position())
    d, why = choose(here)
    direction = DIRECTIONS[d]
    ahead_cell = steps(here)[d]
    eating = ahead_cell in pearls

    # An extra step spends a segment, so only sprint onto food with slack in
    # hand and only straight ahead, where the way is already known to be clear.
    sprinting = (
        length >= SPRINT_AT_LENGTH
        and eating
        and ahead_cell * 4 + d not in kelp
        and ct.make_moves([direction, direction])
    )
    if not sprinting:
        ct.make_move(direction)

    ahead = ct.get_position().add_dir(direction)
    if eating:
        ct.draw_indicator_dot(ahead, *PEARL_COLOUR)
    elif why == "exploring":
        ct.draw_indicator_line(ct.get_position(), ahead, *FRONTIER_COLOUR)

    if sprinting:
        ct.output_log(f"sprinting {direction.value} onto a pearl")
    ct.set_indicator_string(f"len {length} {direction.value} ({why}) seen {len(seen)}")
    ct.send_sonar(length)


def main() -> None:
    global ct, game
    ct, game = unswbc.init()
    setup()

    while unswbc.update(ct, game):
        execute_turn()
        unswbc.end_turn()


if __name__ == "__main__":
    main()
