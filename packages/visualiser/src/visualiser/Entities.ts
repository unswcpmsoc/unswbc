// Everything on the board a player can interrogate.
//
// An entity is whatever the cursor can pick out and ask about. Hit-testing
// runs highest z first, so a portal mouth wins over the dragon sitting on it
// and a dragon wins over the water underneath. A portal pair is one entity,
// not two: both mouths report the same id.

import { isDuplicateTorusEdge, type CurrentMap, type Edge } from "./Map";
import type { TimelineFrame } from "./Match";
import type { Vector } from "./Vector";

export type EntityKind = "portal" | "dragon" | "cell";

export type Entity =
    | { kind: "portal"; id: string; pairIndex: number; ends: [Edge, Edge] }
    | { kind: "dragon"; id: string; dragonId: number }
    | { kind: "cell"; id: string; x: number; y: number };

export const entityIdOf = (entity: Entity): string => entity.id;

export const portalEntityId = (pairIndex: number) => `portal:${pairIndex}`;
export const dragonEntityId = (dragonId: number) => `dragon:${dragonId}`;
export const cellEntityId = (x: number, y: number) => `cell:${x},${y}`;

export const sameEntity = (a: Entity | undefined, b: Entity | undefined) => a?.id === b?.id && a !== undefined;

/**
 * How close to a portal mouth counts as touching it, in cells. A mouth is a
 * line with no area, so this is the radius of a capsule around it: a third of
 * a cell out from the line in every direction, ends included.
 */
const PORTAL_GRAB = 1 / 3;

/**
 * Distance in cells from a board point to a boundary. A 'N' edge is the top
 * of its cell and runs one cell east; a 'W' edge is the left side and runs one
 * cell south.
 */
function distanceToEdge(point: Vector, edge: Edge): number {
    if (edge.side === "N") {
        const withinRun = Math.max(edge.x - point.x, 0, point.x - (edge.x + 1));
        return Math.hypot(withinRun, point.y - edge.y);
    }
    const withinRun = Math.max(edge.y - point.y, 0, point.y - (edge.y + 1));
    return Math.hypot(point.x - edge.x, withinRun);
}

function portalAt(point: Vector, map: CurrentMap): Entity | undefined {
    for (let i = 0; i < map.portals.length; i++) {
        const ends = map.portals[i];
        if (ends.some((edge) => !isDuplicateTorusEdge(edge, map) && distanceToEdge(point, edge) <= PORTAL_GRAB)) {
            return { kind: "portal", id: portalEntityId(i), pairIndex: i, ends };
        }
    }
    return undefined;
}

function dragonAt(cell: Vector, frame: TimelineFrame): Entity | undefined {
    for (const [dragonId, cells] of frame.timeline.cellsAt(frame.tau)) {
        if (cells.some((part) => part.x === cell.x && part.y === cell.y)) {
            return { kind: "dragon", id: dragonEntityId(dragonId), dragonId };
        }
    }
    return undefined;
}

/**
 * The entity under a point given in board coordinates, or undefined when the
 * point is off the board entirely.
 */
export function entityAt(point: Vector, frame: TimelineFrame, map: CurrentMap): Entity | undefined {
    const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
    if (cell.x < 0 || cell.y < 0 || cell.x >= map.width || cell.y >= map.height) return undefined;

    return (
        portalAt(point, map) ??
        dragonAt(cell, frame) ?? { kind: "cell", id: cellEntityId(cell.x, cell.y), x: cell.x, y: cell.y }
    );
}

/** The board point an entity's tooltip should hang off, in cells. */
export function entityAnchor(entity: Entity, frame: TimelineFrame): Vector {
    if (entity.kind === "cell") return { x: entity.x + 0.5, y: entity.y + 0.5 };
    if (entity.kind === "portal") {
        const [a] = entity.ends;
        return a.side === "N" ? { x: a.x + 0.5, y: a.y } : { x: a.x, y: a.y + 0.5 };
    }
    for (const [dragonId, cells] of frame.timeline.cellsAt(frame.tau)) {
        if (dragonId === entity.dragonId && cells.length > 0) {
            return { x: cells[0].x + 0.5, y: cells[0].y + 0.5 };
        }
    }
    return { x: 0, y: 0 };
}
