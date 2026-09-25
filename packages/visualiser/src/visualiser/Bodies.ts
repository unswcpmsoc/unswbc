// Dragon state (`Dragon`, `Bodies`) and the geometry that turns a dragon's motion
// at one instant into a drawable `DragonView`.

import type { GameEvent, DragonData, TeamId } from "./Schema";
import { CurrentMap, portalDirection, stepFrom, type Edge } from "./Map";
import { ARC_SAMPLES, CORNER_RADIUS } from "./constants";
import {
    DIRECTION_DELTA,
    OPPOSITE,
    directionBetween,
    vectorAdd,
    vectorDist,
    vectorEq,
    vectorLerp,
    vectorSub,
    wrappedDirectionBetween,
    type BoardSize,
    type Direction,
    type Vector,
} from "./Vector";

/** One dragon. `body[0]` is the head; consecutive cells may be portal-separated. */
export class Dragon {
    constructor(
        public readonly id: number,
        public readonly team: TeamId,
        public facing: Direction,
        public body: Vector[],
    ) {}

    static fromData(data: DragonData): Dragon {
        return new Dragon(
            data.id,
            data.team,
            data.facing,
            data.body.map((p) => ({ ...p })),
        );
    }

    copy(): Dragon {
        return new Dragon(
            this.id,
            this.team,
            this.facing,
            this.body.map((p) => ({ ...p })),
        );
    }
}

/** All dragons on the board for one round. */
export class Bodies {
    public readonly dragons: Map<number, Dragon> = new Map();

    constructor(initial?: DragonData[] | Bodies) {
        if (initial instanceof Bodies) {
            for (const [id, dragon] of initial.dragons) this.dragons.set(id, dragon.copy());
        } else if (initial) {
            for (const data of initial) this.dragons.set(data.id, Dragon.fromData(data));
        }
    }

    copy(): Bodies {
        return new Bodies(this);
    }

    get count(): number {
        return this.dragons.size;
    }

    getById(id: number): Dragon | undefined {
        return this.dragons.get(id);
    }

    /** Apply one dragon event. Unknown ids are ignored. */
    applyEvent(event: GameEvent): void {
        switch (event.type) {
            case "dragonUpdate": {
                const dragon = this.dragons.get(event.id);
                if (!dragon) break;
                dragon.facing = event.facing;
                // Push the new head, then pop until the declared tail is reached.
                dragon.body.unshift({ ...event.head });
                while (dragon.body.length > 1 && !vectorEq(dragon.body[dragon.body.length - 1], event.tail)) {
                    dragon.body.pop();
                }
                break;
            }
            case "dragonSplit": {
                const parent = this.dragons.get(event.parentId);
                if (parent) parent.body = event.parentBody.map((p) => ({ ...p }));
                this.dragons.set(
                    event.childId,
                    new Dragon(
                        event.childId,
                        event.team,
                        event.childFacing,
                        event.childBody.map((p) => ({ ...p })),
                    ),
                );
                break;
            }
            case "dragonDeath":
                this.dragons.delete(event.id);
                break;
        }
    }
}

// --- Geometry -----------------------------------------------------------------
// A `DragonMotion` says where a dragon's cells are and how far its ends have
// travelled at one instant; `layoutDragon` turns that into curves, poses and
// per-cell coverage. Nothing here infers motion: the timeline that compiles a
// round's events decides what is moving.

/** Colour wash over a dragon. */
export interface DragonTint {
    color: string;
    /** 0 = none, 1 = full. */
    strength: number;
}

/**
 * How much of one cell the body art covers, measured along the body's flow
 * through the cell: 0 is the tail side, 1 the head side. A cell an end cap
 * sits in has no body art of its own.
 */
export interface CellCover {
    cell: Vector;
    from: number;
    to: number;
}

/** Everything a dragon skin needs to draw one dragon at one moment. */
export interface DragonView {
    id: number;
    team: TeamId;
    facing: Direction;
    /** The body curve: rounded, end-trimmed polylines, split at portals. */
    segments: Vector[][];
    /** Settled body cells (head first) once the current motion completes. */
    cells: Vector[];
    /** Every cell the dragon touches right now, head end first, with body-art coverage. */
    occupancy: CellCover[];
    /** Interpolated head pixel position. */
    head: Vector;
    /** Unit vector the head points along. */
    headDir: Vector;
    /** Interpolated tail tip pixel position. */
    tail: Vector;
    /** Unit vector pointing from the tail along the body. */
    tailDir: Vector;
    /** 0..1 opacity: death fades out, spawn fades in. */
    alpha: number;
    /** Dying-dragon colour wash. */
    tint?: DragonTint;
    /** Head-first death dissolve progress in occupancy entries, or undefined if alive. */
    dissolve?: number;
    /** Body thickness/sprite scale multiplier. */
    scale: number;
    /** This dragon's own movement progress (1 when stationary). */
    moveT: number;
    /** A fading image of a body that no longer exists, e.g. the whole dragon before a split. */
    ghost?: boolean;
}

/** A dragon's cells and how far its ends have travelled at one instant. */
export interface DragonMotion {
    id: number;
    team: TeamId;
    facing: Direction;
    /** Body once the motion completes, head first. */
    cells: Vector[];
    /** Cells the head enters in this motion (`cells[0..headSteps-1]`); unset or 0 when still. */
    headSteps?: number;
    /** How far the head has travelled through those cells, 0..headSteps. */
    headProgress?: number;
    /** Cells the tail is still leaving, furthest first. */
    leave?: Vector[];
    /** Cells of `leave` the tail tip still has to travel; 0 means settled. */
    tailToGo?: number;
    /** Cell a dying head is bumping into, and how far it has gone (fraction of a cell). */
    contact?: Vector;
    contactAdvance?: number;
    alpha: number;
    tint?: DragonTint;
    dissolve?: number;
    moveT: number;
}

function center(p: Vector, cell: number): Vector {
    return { x: (p.x + 0.5) * cell, y: (p.y + 0.5) * cell };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The step that takes a dragon from `from` to `to`, or undefined if the two
 * cells are not one step apart at all. Given a `CurrentMap` this is the
 * engine's own rule, so kelp blocks and a portal leads to its partner.
 *
 * With only a board size it guesses: plain adjacency first, then through a
 * portal, then off one side of the board and onto the other. A portal outranks
 * the wrap because the two readings collide: a portal joining the inside of one
 * side to the far side puts the dragon on the opposite edge, which is also
 * where the wrap would have taken it, and the wrap is the wrong one whenever
 * the border is kelp.
 */
export function stepBetween(
    from: Vector,
    to: Vector,
    board: BoardSize | CurrentMap,
    portals: readonly (readonly [Edge, Edge])[],
): Direction | undefined {
    if (board instanceof CurrentMap) {
        const plain = directionBetween(from, to) ?? wrappedDirectionBetween(from, to, board);
        const dirs: Direction[] = plain ? [plain, "N", "E", "S", "W"] : ["N", "E", "S", "W"];
        return dirs.find((dir) => {
            const next = stepFrom(board, from, dir);
            return next !== undefined && vectorEq(next, to);
        });
    }
    return (
        directionBetween(from, to) ??
        portalDirection(portals, from, to, board) ??
        wrappedDirectionBetween(from, to, board)
    );
}

/**
 * A body laid out as one unbroken polyline, however its cells are scattered by
 * seams and portals. Every vertex also carries the offset that puts it back
 * where it belongs on the board, so the curve can be drawn continuously and
 * then cut into the pieces the board actually shows.
 */
interface Spine {
    /** Cell centres, each placed one cell from the last. */
    points: Vector[];
    /** Added to a point to move it from spine space to board space. */
    offsets: Vector[];
}

/** Lay out `cells` head-first as a continuous curve. */
function buildSpine(
    cells: Vector[],
    cell: number,
    board: BoardSize,
    portals: readonly (readonly [Edge, Edge])[],
): Spine {
    const points: Vector[] = [center(cells[0], cell)];
    const offsets: Vector[] = [{ x: 0, y: 0 }];

    for (let i = 1; i < cells.length; i++) {
        const step = stepBetween(cells[i], cells[i - 1], board, portals);
        const boardCentre = center(cells[i], cell);
        if (!step) {
            // Not one step apart, so there is nothing to lay out continuously.
            points.push(boardCentre);
            offsets.push({ x: 0, y: 0 });
            continue;
        }
        const delta = DIRECTION_DELTA[step];
        const spinePoint = {
            x: points[i - 1].x - delta.x * cell,
            y: points[i - 1].y - delta.y * cell,
        };
        points.push(spinePoint);
        offsets.push(vectorSub(boardCentre, spinePoint));
    }

    return { points, offsets };
}

/**
 * Cut a drawn curve wherever the board sends it somewhere else, and move each
 * run to where it belongs. `arcOf` gives the arc length of each spine vertex,
 * so a crossing lands halfway between the two cells it joins: exactly their
 * shared boundary.
 */
function toBoardSpace(points: Vector[], arcLengths: number[], spine: Spine, arcOf: number[]): Vector[][] {
    const crossings: { at: number; offset: Vector }[] = [];
    for (let i = 1; i < spine.offsets.length; i++) {
        if (vectorEq(spine.offsets[i], spine.offsets[i - 1])) continue;
        crossings.push({ at: (arcOf[i - 1] + arcOf[i]) / 2, offset: spine.offsets[i] });
    }

    const runs: Vector[][] = [];
    let current: Vector[] = [];
    let offset = spine.offsets[0];
    let next = 0;
    for (let i = 0; i < points.length; i++) {
        while (next < crossings.length && arcLengths[i] >= crossings[next].at) {
            const crossing = crossings[next];
            // Both runs have to reach the boundary, or the arriving end of the
            // dragon is drawn as a stub rather than sliding out of the far side.
            const span = arcLengths[i] - arcLengths[i - 1];
            const meeting =
                i > 0 && span > 1e-6
                    ? vectorLerp(points[i - 1], points[i], (crossing.at - arcLengths[i - 1]) / span)
                    : points[i];
            if (current.length) {
                current.push(vectorAdd(meeting, offset));
                runs.push(current);
            }
            current = [vectorAdd(meeting, crossing.offset)];
            offset = crossing.offset;
            next++;
        }
        current.push(vectorAdd(points[i], offset));
    }
    if (current.length) runs.push(current);
    return runs.filter((run) => run.length > 0);
}

// --- Rounded-path geometry ----------------------------------------------------
// Corners are sampled into dense points, then the ends are trimmed by arc
// length so the head/tail tips sweep along the curve.

interface SampledPath {
    points: Vector[];
    lengths: number[];
    /** Arc length at each original spine vertex. */
    markers: number[];
}

/** Round a spine's corners and measure the result. */
function samplePath(spine: Vector[], cell: number): SampledPath {
    const points: Vector[] = [spine[0]];
    const markerIndex: number[] = [0];
    for (let i = 1; i < spine.length - 1; i++) {
        const prev = spine[i - 1];
        const v = spine[i];
        const next = spine[i + 1];
        const lenIn = vectorDist(prev, v);
        const lenOut = vectorDist(v, next);
        // Clamp radius so short runs can't overlap neighbouring corners.
        const r = Math.min(cell * CORNER_RADIUS, lenIn / 2, lenOut / 2);
        if (lenIn < 1e-6 || lenOut < 1e-6 || r < 0.01) {
            points.push(v);
            markerIndex.push(points.length - 1);
            continue;
        }
        const inDir = { x: (v.x - prev.x) / lenIn, y: (v.y - prev.y) / lenIn };
        const outDir = { x: (next.x - v.x) / lenOut, y: (next.y - v.y) / lenOut };
        // Straight run: keep the sharp point.
        if (Math.abs(inDir.x * outDir.y - inDir.y * outDir.x) < 1e-6) {
            points.push(v);
            markerIndex.push(points.length - 1);
            continue;
        }
        // Circular arc through the corner, so the spine follows the same path
        // as the corner body art.
        const a = { x: v.x - inDir.x * r, y: v.y - inDir.y * r };
        const b = { x: v.x + outDir.x * r, y: v.y + outDir.y * r };
        const turn = inDir.x * outDir.y - inDir.y * outDir.x;
        const nx = turn > 0 ? -inDir.y : inDir.y;
        const ny = turn > 0 ? inDir.x : -inDir.x;
        const cx = a.x + nx * r;
        const cy = a.y + ny * r;
        const from = Math.atan2(a.y - cy, a.x - cx);
        let sweep = Math.atan2(b.y - cy, b.x - cx) - from;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        markerIndex.push(points.length + ARC_SAMPLES / 2);
        for (let k = 0; k <= ARC_SAMPLES; k++) {
            const ang = from + (sweep * k) / ARC_SAMPLES;
            points.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
        }
    }
    if (spine.length > 1) {
        points.push(spine[spine.length - 1]);
        markerIndex.push(points.length - 1);
    }
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
        lengths.push(lengths[i - 1] + vectorDist(points[i - 1], points[i]));
    }
    return { points, lengths, markers: markerIndex.map((i) => lengths[i]) };
}

/** The point at arc length `s` along the sampled path (clamped). */
function pointAt(path: SampledPath, s: number): Vector {
    const { points, lengths } = path;
    const total = lengths[lengths.length - 1];
    if (s <= 0) return { ...points[0] };
    if (s >= total) return { ...points[points.length - 1] };
    let i = 1;
    while (lengths[i] < s) i++;
    const segLen = lengths[i] - lengths[i - 1];
    const f = segLen > 0 ? (s - lengths[i - 1]) / segLen : 0;
    return vectorLerp(points[i - 1], points[i], f);
}

/** The sub-polyline between arc lengths `s0` and `s1` (a single point when degenerate). */
function trimPath(path: SampledPath, s0: number, s1: number): Vector[] {
    const total = path.lengths[path.lengths.length - 1];
    const from = Math.max(0, Math.min(s0, total));
    const to = Math.max(from, Math.min(s1, total));
    if (to - from < 1e-3) return [pointAt(path, (from + to) / 2)];
    const out: Vector[] = [pointAt(path, from)];
    for (let i = 0; i < path.points.length; i++) {
        if (path.lengths[i] > from && path.lengths[i] < to) out.push(path.points[i]);
    }
    out.push(pointAt(path, to));
    return out;
}

/** Cumulative distance along a polyline, starting at zero. */
function arcLengthsOf(points: Vector[]): number[] {
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
        lengths.push(lengths[i - 1] + vectorDist(points[i - 1], points[i]));
    }
    return lengths;
}

/** The board-space offset in force at `arcLength` along the spine. */
function offsetAt(spine: Spine, arcOf: number[], arcLength: number): Vector {
    let offset = spine.offsets[0];
    for (let i = 1; i < spine.offsets.length; i++) {
        if (vectorEq(spine.offsets[i], spine.offsets[i - 1])) continue;
        if (arcLength >= (arcOf[i - 1] + arcOf[i]) / 2) offset = spine.offsets[i];
    }
    return offset;
}

/** Unit direction from `a` to `b`; east when they coincide. */
function dirBetween(a: Vector, b: Vector): Vector {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

/**
 * The body's cut through cell `c` (spine space, cell units) as an end cap
 * crosses it: `u` of the way from the side the body entered by to the side it
 * leaves by. A straight run cuts square across; a bend sweeps the cut around
 * the tile corner, matching the radial wipe the corner art makes, so a cap
 * placed half a cell from the cut sits on the cell centres at both ends.
 */
function sweepCut(c: Vector, entryDir: Vector, exitDir: Vector, u: number): { cut: Vector; dir: Vector } {
    const entryMid = { x: c.x - entryDir.x / 2, y: c.y - entryDir.y / 2 };
    const exitMid = { x: c.x + exitDir.x / 2, y: c.y + exitDir.y / 2 };
    if (Math.abs(entryDir.x - exitDir.x) < 1e-9 && Math.abs(entryDir.y - exitDir.y) < 1e-9) {
        return { cut: vectorLerp(entryMid, exitMid, u), dir: exitDir };
    }
    const pivot = {
        x: Math.abs(entryDir.x) > 1e-9 ? entryMid.x : exitMid.x,
        y: Math.abs(entryDir.y) > 1e-9 ? entryMid.y : exitMid.y,
    };
    const a0 = Math.atan2(entryMid.y - pivot.y, entryMid.x - pivot.x);
    let sweep = Math.atan2(exitMid.y - pivot.y, exitMid.x - pivot.x) - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const ang = a0 + sweep * u;
    const spin = sweep >= 0 ? 1 : -1;
    return {
        cut: { x: pivot.x + CORNER_RADIUS * Math.cos(ang), y: pivot.y + CORNER_RADIUS * Math.sin(ang) },
        dir: { x: -Math.sin(ang) * spin, y: Math.cos(ang) * spin },
    };
}

/**
 * Board-space position of a point given in spine space, using the offset of
 * whichever of two neighbouring spine cells it falls in.
 */
function placeBetween(spine: Spine, cell: number, point: Vector, fromIdx: number, toIdx: number): Vector {
    const from = spine.points[fromIdx];
    const to = spine.points[toIdx];
    const mid = { x: (from.x + to.x) / (2 * cell), y: (from.y + to.y) / (2 * cell) };
    const ahead = dirBetween(from, to);
    const past = (point.x - mid.x) * ahead.x + (point.y - mid.y) * ahead.y > 0;
    const offset = spine.offsets[past ? toIdx : fromIdx];
    return { x: point.x * cell + offset.x, y: point.y * cell + offset.y };
}

/**
 * Build the drawable view of one dragon from its motion. The body plus the
 * cells its tail is still leaving form one continuous curve, trimmed at the
 * head end by how far the head has advanced and at the tail end by how far the
 * tip has still to go; body art in each cell ends half a cell short of each
 * tip, where the end caps take over.
 */
export function layoutDragon(
    m: DragonMotion,
    cell: number,
    portals: readonly (readonly [Edge, Edge])[] = [],
    board: BoardSize = { width: Infinity, height: Infinity },
): DragonView {
    const leave = m.leave ?? [];
    const toGo = leave.length ? Math.max(0, Math.min(leave.length, m.tailToGo ?? 0)) : 0;
    const spineCells = [...(m.contact ? [m.contact] : []), ...m.cells, ...[...leave].reverse()];
    const steps = m.contact ? 1 : Math.max(0, m.headSteps ?? 0);
    const progress = Math.max(0, Math.min(steps, m.contact ? (m.contactAdvance ?? 0) : (m.headProgress ?? 0)));
    const headMoving = steps > 0;
    // Where the head tip sits in spine-index units: `steps` at the start of
    // the motion, 0 once it has arrived.
    const tipIndex = steps - progress;
    const settledIdx = spineCells.length - 1 - leave.length;
    // The leave cell the tail tip is currently crossing (0 = already settled)
    // and how far across it is.
    const k = Math.ceil(toGo - 1e-9);
    const u = k > 0 ? k - toGo : 0;

    const spine = buildSpine(spineCells, cell, board, portals);
    const segments: Vector[][] = [];
    if (spine.points.length < 2) {
        segments.push(spine.points.map((p) => vectorAdd(p, spine.offsets[0])));
    } else {
        const path = samplePath(spine.points, cell);
        const kh = Math.ceil(tipIndex - 1e-9);
        const s0 = kh <= 0 ? 0 : path.markers[kh] + (path.markers[kh - 1] - path.markers[kh]) * (kh - tipIndex);
        const s1 =
            k <= 0
                ? path.markers[settledIdx]
                : path.markers[settledIdx + k] + (path.markers[settledIdx + k - 1] - path.markers[settledIdx + k]) * u;
        const drawn = trimPath(path, s0, s1);
        const arcLengths = arcLengthsOf(drawn);
        for (const run of toBoardSpace(
            drawn,
            arcLengths.map((d) => d + s0),
            spine,
            path.markers,
        )) {
            segments.push(run);
        }
    }

    // Body art in each cell ends half a cell short of each tip; the caps cover
    // the rest. `to` measures how far the head tip is past the cell's centre,
    // `from` how far the tail tip still has to come.
    const occupancy: CellCover[] = spineCells.map((c, i) => {
        const to = headMoving ? clamp01(i - tipIndex) : i === 0 ? 0 : 1;
        const fromTail = i - settledIdx;
        const from = fromTail >= 0 ? clamp01(fromTail + 1 - toGo) : 0;
        return { cell: c, from, to };
    });

    const unit = (p: Vector) => ({ x: p.x / cell, y: p.y / cell });

    // Head pose. While moving, the cap crosses the cell it is leaving half a
    // cell ahead of the body's cut, sweeping the corner if that cell bends, so
    // it runs from centre to centre and turns as it goes. At rest it points
    // exactly away from the neck, or along `facing` for a lone cell.
    let head: Vector;
    let headDir = DIRECTION_DELTA[m.facing];
    if (headMoving) {
        const stepIdx = Math.min(steps - 1, Math.floor(progress));
        const p = progress - stepIdx;
        const leaving = steps - stepIdx;
        const entering = leaving - 1;
        const exitDir = dirBetween(spine.points[leaving], spine.points[entering]);
        const entryDir =
            leaving + 1 < spine.points.length ? dirBetween(spine.points[leaving + 1], spine.points[leaving]) : exitDir;
        const { cut, dir } = sweepCut(unit(spine.points[leaving]), entryDir, exitDir, p);
        head = placeBetween(spine, cell, { x: cut.x + dir.x / 2, y: cut.y + dir.y / 2 }, leaving, entering);
        headDir = dir;
    } else {
        head = center(spineCells[0], cell);
        if (m.cells.length > 1) {
            const back = stepBetween(m.cells[0], m.cells[1], board, portals);
            if (back) headDir = DIRECTION_DELTA[OPPOSITE[back]];
        }
    }

    // Tail pose, the mirror image: the cap trails half a cell behind the cut
    // through the cell it is entering.
    let tail: Vector;
    let tailDir: Vector;
    if (k > 0) {
        const tipIdx = settledIdx + k;
        const nextIdx = tipIdx - 1;
        const entryDir = dirBetween(spine.points[tipIdx], spine.points[nextIdx]);
        const exitDir = nextIdx > 0 ? dirBetween(spine.points[nextIdx], spine.points[nextIdx - 1]) : entryDir;
        const { cut, dir } = sweepCut(unit(spine.points[nextIdx]), entryDir, exitDir, u);
        tail = placeBetween(spine, cell, { x: cut.x - dir.x / 2, y: cut.y - dir.y / 2 }, tipIdx, nextIdx);
        tailDir = dir;
    } else {
        tail = center(spineCells[settledIdx], cell);
        tailDir =
            DIRECTION_DELTA[
                (settledIdx > 0
                    ? stepBetween(spineCells[settledIdx], spineCells[settledIdx - 1], board, portals)
                    : undefined) ?? OPPOSITE[m.facing]
            ];
    }

    return {
        id: m.id,
        team: m.team,
        facing: m.facing,
        segments,
        cells: m.cells,
        occupancy,
        head,
        headDir,
        tail,
        tailDir,
        alpha: m.alpha,
        tint: m.tint,
        dissolve: m.dissolve,
        scale: 1,
        moveT: m.moveT,
    };
}

/** Every dragon drawn at rest, e.g. for a static preview. */
export function settledDragonViews(
    bodies: Bodies,
    cell: number,
    portals: readonly (readonly [Edge, Edge])[] = [],
    board: BoardSize = { width: Infinity, height: Infinity },
): DragonView[] {
    return [...bodies.dragons.values()].map((dragon) =>
        layoutDragon(
            { id: dragon.id, team: dragon.team, facing: dragon.facing, cells: dragon.body, alpha: 1, moveT: 1 },
            cell,
            portals,
            board,
        ),
    );
}

// --- Sprite classification ----------------------------------------------------

/** Base rotations. East-facing sprite at 0; straight body flows west→east. */
const ROT: Record<Direction, number> = { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 };

/** Rotation per corner shape, keyed by sorted neighbour-direction pair. */
const TURN_ROT: Record<string, number> = {
    EN: 0,
    ES: Math.PI / 2,
    SW: Math.PI,
    NW: -Math.PI / 2,
};

const CLOCKWISE: Record<Direction, Direction> = { N: "E", E: "S", S: "W", W: "N" };

export type DragonPart = "head" | "body" | "turn" | "tail";

export interface BodySegment {
    kind: DragonPart;
    rot: number;
    /** For turns: bend direction relative to tail→head flow. */
    turnDir?: "left" | "right";
}

/**
 * Classify each body cell as head/body/turn/tail with the rotation that
 * connects it to its neighbours. Pass `board` and `portals` so cells separated
 * by a seam or a portal still resolve to the direction that joins them; without
 * them such a cell reads as unconnected and is drawn as a straight run, which
 * loses the bend a dragon makes as it crosses.
 */
export function classifyBody(
    cells: Vector[],
    facing: Direction,
    portals: readonly (readonly [Edge, Edge])[] = [],
    board: BoardSize = { width: Infinity, height: Infinity },
): BodySegment[] {
    const n = cells.length;
    if (n === 1) return [{ kind: "head", rot: ROT[facing] }];

    const dirTo = (from: Vector, to: Vector): Direction | undefined => stepBetween(from, to, board, portals);

    return cells.map((cell, i): BodySegment => {
        if (i === 0) {
            // Head points away from its neck.
            const back = dirTo(cell, cells[1]);
            return { kind: "head", rot: ROT[back ? OPPOSITE[back] : facing] };
        }
        if (i === n - 1) {
            const dir = dirTo(cell, cells[i - 1]) ?? facing;
            return { kind: "tail", rot: ROT[dir] };
        }
        const toHead = dirTo(cell, cells[i - 1]);
        const toTail = dirTo(cell, cells[i + 1]);
        // Straight run (including portal-adjacent cells and doubled-back bodies).
        if (!toHead || !toTail || toTail === toHead || toHead === OPPOSITE[toTail]) {
            const dir = toHead ?? OPPOSITE[toTail ?? "E"];
            return { kind: "body", rot: ROT[dir] };
        }
        return {
            kind: "turn",
            rot: TURN_ROT[[toHead, toTail].sort().join("")],
            turnDir: toTail === CLOCKWISE[toHead] ? "right" : "left",
        };
    });
}
