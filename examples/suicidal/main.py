#!/usr/bin/env python3
"""Aggressive sparring bot: eats whatever it can reach, dives through any portal
it has not used yet, and otherwise trades itself for an enemy head.

The three behaviours are tried strictly in that order, so it only goes hunting
once there is nothing left to eat and no fresh portal to take. Ramming a head
kills both dragons, which is the point: this is a playtesting partner, not a
contender.
"""

from collections import deque

import helper as unswbc
from helper import Constants, Direction, Position

ct: unswbc.Controller
game: unswbc.Game

# Caps the search so a turn fits the judge's budget: a step of the search is
# about 100 thousand points in Python, and a turn has 100 million.
SEARCH_BUDGET = 300
# An extra step spends a segment and only the pearl it eats pays one back, so a
# sprint is worth it over a short hop and not a long march.
SPRINT_REACH = 3

PEARL_COLOUR = (255, 210, 90)
PORTAL_COLOUR = (150, 120, 255)
TARGET_COLOUR = (255, 60, 60)

OFFSETS = {"N": (0, -1), "E": (1, 0), "S": (0, 1), "W": (-1, 0)}

# This round's vision, as sets the search can test a cell against in one
# lookup. A step of the search has to be cheap: the judge gives a turn 100
# million points and a step that parses tiles costs a hundred thousand.
occupied_cells: set[tuple[int, int]] = set()
enemy_heads: set[tuple[int, int]] = set()

# Remembered across rounds.
seen: set[tuple[int, int]] = set()
kelp: set[tuple[tuple[int, int], str]] = set()
portals: set[tuple[tuple[int, int], str]] = set()
taken_portals: set[tuple[tuple[int, int], str]] = set()
fresh_portal_cells: set[tuple[int, int]] = set()
remembered_pearls: set[tuple[int, int]] = set()
# Each cell's open sides and what lies across them, dropped for a cell when a
# wall or portal is learned on it.
neighbours: dict[tuple[int, int], list[tuple[str, tuple[int, int]]]] = {}


def key(pos: Position) -> tuple[int, int]:
    return (pos.x, pos.y)


def observe() -> None:
    """Fold this round's vision into the remembered map."""
    occupied_cells.clear()
    enemy_heads.clear()
    for tile in ct.get_vision().get_tiles():
        cell = key(tile.position)
        seen.add(cell)

        entity = tile.entity
        if isinstance(entity, unswbc.DragonPart):
            occupied_cells.add(cell)
            if entity.is_head() and entity.get_team() != ct.get_team():
                enemy_heads.add(cell)

        # A tile in view settles whether it holds a pearl, so stale memory of
        # one that has since been eaten is dropped here.
        if isinstance(entity, unswbc.Pearl):
            remembered_pearls.add(cell)
        else:
            remembered_pearls.discard(cell)

        for direction in Direction.get_direction_list():
            edge = tile.get_edge(direction)
            if edge is None:
                continue
            side = direction.value
            if not edge.is_passable():
                if (cell, side) not in kelp:
                    kelp.add((cell, side))
                    neighbours.pop(cell, None)
                    beyond = key(tile.position.add_dir(direction))
                    kelp.add((beyond, direction.get_opposite().value))
                    neighbours.pop(beyond, None)
            elif edge.is_portal() and (cell, side) not in portals:
                portals.add((cell, side))
                neighbours.pop(cell, None)
                if (cell, side) not in taken_portals:
                    fresh_portal_cells.add(cell)


def occupied(cell: tuple[int, int]) -> bool:
    """Dragons are only known where we can currently see them."""
    return cell in occupied_cells


def unused_portal_side(cell: tuple[int, int]) -> "str | None":
    """A portal on this cell we have never gone through. What lies beyond one is
    unknown until it is taken, so an unused one is the cheapest way to reach
    ground no amount of walking will."""
    for direction in Direction.get_direction_list():
        side = (cell, direction.value)
        if side in portals and side not in taken_portals:
            return direction.value
    return None


def steps_from(cell: tuple[int, int]):
    """Neighbours across water with no remembered kelp. Unseen edges are assumed
    open: the route is redone every round, so guessing wrong costs one step.
    Portals are left out because their far side cannot be routed through."""
    steps = neighbours.get(cell)
    if steps is None:
        x, y = cell
        steps = [(side, ((x + dx) % game.width, (y + dy) % game.height))
                 for side, (dx, dy) in OFFSETS.items()
                 if (cell, side) not in kelp and (cell, side) not in portals]
        neighbours[cell] = steps
    return steps


def routes() -> dict:
    """Breadth-first over the remembered map, once, returning every step of
    the shortest route to the nearest free pearl, fresh portal and enemy head.
    The search stops at the first pearl; the others are whatever it passed on
    the way, which is what a search of their own to the same budget would
    find. One search a turn is all the budget allows, and its loop is set
    lookups only. An occupied cell is never routed through, but it may be a
    target itself, which is how a head gets rammed."""
    start = key(ct.get_position())
    came_from: dict[tuple[int, int], tuple[tuple[int, int], str]] = {}
    queue = deque([start])
    visited = {start}
    found: dict = {}

    while queue and len(visited) < SEARCH_BUDGET:
        cell = queue.popleft()
        if cell != start:
            if cell in occupied_cells:
                if "head" not in found and cell in enemy_heads:
                    found["head"] = cell
                continue
            if cell in remembered_pearls:
                found["pearl"] = cell
                break
            if "portal" not in found and cell in fresh_portal_cells:
                found["portal"] = cell
        for side, beyond in steps_from(cell):
            if beyond not in visited:
                visited.add(beyond)
                came_from[beyond] = (cell, side)
                queue.append(beyond)

    result = {}
    for name, cell in found.items():
        route = []
        while cell != start:
            cell, side = came_from[cell]
            route.append(side)
        route.reverse()
        result[name] = route
    return result


def legal_steps() -> list[Direction]:
    """Steps that are not into kelp or our own neck. The neck can sit across a
    portal and out of sight, so facing is the only guide. A body in the way is
    not filtered here: walking into one is a death this bot is willing to take,
    and walking into a head is the whole point."""
    here = key(ct.get_position())
    reverse = ct.get_dir().get_opposite()
    return [direction for direction in Direction.get_direction_list()
            if direction != reverse and (here, direction.value) not in kelp]


def sprint(route: list[str]) -> list[Direction]:
    """The whole route in one turn when the pearl is close and the body can pay
    for it, a single step otherwise."""
    steps = [Direction(side) for side in route]
    affordable = ct.get_length() - (len(steps) - 1) >= Constants.MIN_SIZE
    if len(steps) <= SPRINT_REACH and affordable:
        return steps
    return steps[:1]


def choose() -> tuple[list[Direction], str]:
    """Eat, else take a portal, else ram a head. A portal already used is no
    longer a way anywhere new, so it does not hold the bot back from hunting."""
    legal = legal_steps()
    if not legal:
        return [ct.get_dir()], "boxed in"
    allowed = {direction.value for direction in legal}
    here = key(ct.get_position())
    found = routes()

    route = found.get("pearl")
    if route and route[0] in allowed:
        return sprint(route), "eating"

    side = unused_portal_side(here)
    if side is not None and side in allowed:
        taken_portals.add((here, side))
        if unused_portal_side(here) is None:
            fresh_portal_cells.discard(here)
        return [Direction(side)], "through a portal"

    route = found.get("portal")
    if route and route[0] in allowed:
        return [Direction(route[0])], "to a portal"

    route = found.get("head")
    if route and route[0] in allowed:
        return [Direction(route[0])], "hunting a head"

    open_water = [d for d in legal if not occupied(key(ct.get_position().add_dir(d)))]
    return [(open_water or legal)[0]], "drifting"


def execute_turn() -> None:
    observe()
    steps, why = choose()

    # A rejected multi-step move would leave the turn silent, which the engine
    # counts as no valid action, so fall back to the first step alone.
    if len(steps) == 1 or not ct.make_moves(steps):
        ct.make_move(steps[0])

    target = ct.get_position()
    for step in steps:
        target = target.add_dir(step)

    if why == "eating":
        ct.draw_indicator_dot(target, *PEARL_COLOUR)
    elif why.endswith("portal"):
        ct.draw_indicator_line(ct.get_position(), target, *PORTAL_COLOUR)
    elif why == "hunting a head":
        ct.draw_indicator_line(ct.get_position(), target, *TARGET_COLOUR)

    plan = "".join(step.value for step in steps)
    ct.set_indicator_string(f"len {ct.get_length()} {plan} ({why})")


def main() -> None:
    global ct, game
    ct, game = unswbc.init()

    while unswbc.update(ct, game):
        execute_turn()
        unswbc.end_turn()


if __name__ == "__main__":
    main()
