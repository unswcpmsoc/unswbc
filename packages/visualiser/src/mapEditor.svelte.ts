// Editing model for the .map format, no UI.
//
// Edgemap coordinates: row `2b` holds the horizontal boundaries above tile row
// `b`, columns `0..w-1`; row `2b+1` holds the vertical ones inside it, columns
// `0..w-1`. Rows run `0..2h-1`: bottom/right boundaries use the top/left slot.
// File edge ids still use `row * (w + 1) + column`, matching the engine.

import {
    StaticMap,
    serializeMapText,
    dragonFacing,
    type Edge,
    type MapSymmetry,
    type PearlRespawnBounds,
} from "./visualiser/Map";
import { EdgeTile } from "./visualiser/Schema";
import { clamp } from "./visualiser/Vector";

export type DrawMode = "draw" | "erase";
export type Symmetry = MapSymmetry;
export type BrushType = "kelp" | "portal" | "pearl" | "dragon";

/**
 * Which part of the map the editor is working on. Everything outside the
 * chosen layer is drawn faded.
 */
export type EditorLayer = "all" | "kelp" | "portals" | "pearls" | "dragons";

/** false = open water, true = kelp. Portals are held in `editor.portals`. */
export type EdgeValue = boolean;

/** One end of a portal, in edgemap coordinates. */
export type PortalEnd = [number, number];

export interface EditorDragon {
    team: 0 | 1;
    /** Head first; consecutive cells must be 4-neighbours across open water. */
    body: [number, number][];
}

export const MAX_SIZE = 64;
export const MIN_SIZE = 10;

/** Modifier keys held during a paint; they override the panel's brush. */
export interface Modifiers {
    ctrl: boolean;
    shift: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, shift: false };

/** What the pointer is over: one boundary or one tile. */
export type Target = { kind: "edge" | "tile"; x: number; y: number };

const noPearls = (): PearlRespawnBounds => ({ minRounds: 0, maxRounds: 0 });

const DEFAULT_SIZE = 16;
const DEFAULT_DRAGONS_PER_TEAM = 4;
const DEFAULT_DRAGON_LENGTH = 4;
/** Rounds between pearls appearing anywhere on the board, by default. */
const DEFAULT_BOARD_PEARL_INTERVAL = 5;

function emptyEdges(width: number, height: number): EdgeValue[][] {
    return Array.from({ length: 2 * height }, () => Array<boolean>(width).fill(false));
}

function pearlGrid(width: number, height: number, bounds: PearlRespawnBounds): PearlRespawnBounds[][] {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ...bounds })));
}

/**
 * Respawn bounds giving the whole board one pearl every `roundsPerPearl`
 * rounds. A tile's own wait averages that times the tile count; the range
 * spans the full cycle so tiles start staggered rather than in lockstep.
 */
export function boundsForBoardInterval(roundsPerPearl: number, tileCount: number): PearlRespawnBounds {
    const mean = Math.max(1, Math.round(roundsPerPearl * tileCount));
    return { minRounds: 1, maxRounds: Math.max(1, 2 * mean - 1) };
}

/** Straight dragons along the top-left rows, mirrored for the other team. */
function defaultDragons(width: number, height: number): EditorDragon[] {
    const dragons: EditorDragon[] = [];
    for (let row = 0; row < DEFAULT_DRAGONS_PER_TEAM; row++) {
        const body: [number, number][] = [];
        for (let i = 0; i < DEFAULT_DRAGON_LENGTH; i++) body.push([i, row]);
        dragons.push({ team: 0, body });
        dragons.push({ team: 1, body: body.map(([x, y]) => [width - 1 - x, height - 1 - y]) });
    }
    return dragons;
}

function defaultMapName(): string {
    const now = new Date();
    return `new_map_${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

export const editor = $state({
    name: defaultMapName(),
    w: DEFAULT_SIZE,
    h: DEFAULT_SIZE,
    drawMode: "draw" as DrawMode,
    symm: "xy" as Symmetry,
    unitLimit: undefined as number | undefined,
    brushType: "kelp" as BrushType,
    layer: "all" as EditorLayer,
    pearlBrush: boundsForBoardInterval(DEFAULT_BOARD_PEARL_INTERVAL, DEFAULT_SIZE * DEFAULT_SIZE),
    nextDragonTeam: 0 as 0 | 1,
    dragons: defaultDragons(DEFAULT_SIZE, DEFAULT_SIZE),
    /** Cells clicked so far for the dragon being drawn, head first. */
    dragonDraft: [] as [number, number][],
    portals: [] as [PortalEnd, PortalEnd][],
    /** First end clicked with the portal brush, waiting for its partner. */
    pendingPortal: undefined as PortalEnd | undefined,
    edgemap: emptyEdges(DEFAULT_SIZE, DEFAULT_SIZE),
    pearls: pearlGrid(
        DEFAULT_SIZE,
        DEFAULT_SIZE,
        boundsForBoardInterval(DEFAULT_BOARD_PEARL_INTERVAL, DEFAULT_SIZE * DEFAULT_SIZE),
    ),
});

/** Only top/left copies of wrapped boundaries can be edited. */
export function edgeInRange(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < editor.w && y < 2 * editor.h;
}

export function tileInRange(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < editor.w && y < editor.h;
}

/** The brush each layer edits. `all` leaves the choice to the brush picker. */
const LAYER_BRUSH: Record<Exclude<EditorLayer, "all">, BrushType> = {
    kelp: "kelp",
    portals: "portal",
    pearls: "pearl",
    dragons: "dragon",
};

/**
 * Switch layer forces brush to corresponding layer.
 */
export function setLayer(layer: EditorLayer): void {
    if (layer !== editor.layer) {
        // cancel on layer switch
        cancelDragonDraft();
        editor.pendingPortal = undefined;
    }
    editor.layer = layer;
    if (layer !== "all") editor.brushType = LAYER_BRUSH[layer];
}

/**
 * Pick a brush, and the layer that shows what it paints.
 */
export function setBrush(brush: BrushType): void {
    if (brush === "pearl") {
        setLayer("pearls");
        return;
    }
    editor.brushType = brush;
}

/** The tile this one mirrors onto. */
export function mirrorTile(x: number, y: number): [number, number] {
    const { w, h, symm } = editor;
    if (symm === "y") return [w - 1 - x, y];
    if (symm === "x") return [x, h - 1 - y];
    return [w - 1 - x, h - 1 - y];
}

/**
 * The boundary this one mirrors onto.
 **/
export function mirrorEdge(x: number, y: number): [number, number] {
    const { w, h, symm } = editor;
    const flippedX = y % 2 === 0 ? w - 1 - x : w - x;
    if (symm === "y") return canonicalEdge(flippedX, y);
    if (symm === "x") return canonicalEdge(x, 2 * h - y);
    return canonicalEdge(flippedX, 2 * h - y);
}

const sameCell = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

/** Fold a bottom/right boundary onto its top/left storage slot. */
function canonicalEdge(x: number, y: number, width = editor.w, height = editor.h): PortalEnd {
    return [y % 2 !== 0 && x === width ? 0 : x, y === 2 * height ? 0 : y];
}

/**
 * A boundary and its mirror, stored once even where symmetry crosses the seam.
 **/
export function mirroredEdges(x: number, y: number): [number, number][] {
    if (!edgeInRange(x, y)) return [];
    const mirror = mirrorEdge(x, y);
    return sameCell(mirror, [x, y]) ? [[x, y]] : [[x, y], mirror];
}

/** A tile and its mirror, or just the one where it mirrors onto itself. */
function mirroredTiles(x: number, y: number): [number, number][] {
    const mirror = mirrorTile(x, y);
    return sameCell(mirror, [x, y]) ? [[x, y]] : [[x, y], mirror];
}

// Which way a boundary piece is facing
function edgeAxis(y: number): "horizontal" | "vertical" {
    return y % 2 === 0 ? "horizontal" : "vertical";
}

// Checks if two portals are aligned
function portalAligned(a: PortalEnd, b: PortalEnd): boolean {
    return edgeAxis(a[1]) === edgeAxis(b[1]);
}

/** The same two slots, either way round. */
function sameSlots(p: [PortalEnd, PortalEnd], q: [PortalEnd, PortalEnd]): boolean {
    return (sameCell(p[0], q[0]) && sameCell(p[1], q[1])) || (sameCell(p[0], q[1]) && sameCell(p[1], q[0]));
}

/**
 * Whether this boundary is its own mirror, which puts it on the axis of
 * symmetry.
 */
export function onAxis(x: number, y: number): boolean {
    return sameCell([x, y], mirrorEdge(x, y));
}

/** Unglue all pairs touching these slots. */
function dropPortalsAt(ends: PortalEnd[]): void {
    const matches = (slot: PortalEnd) => ends.some((end) => sameCell(slot, end));
    editor.portals = editor.portals.filter((pair) => !pair.some(matches));
    if (editor.pendingPortal && matches(editor.pendingPortal)) editor.pendingPortal = undefined;
}

function writeEdges(edges: PortalEnd[], value: EdgeValue): void {
    const inside = edges.filter(([x, y]) => edgeInRange(x, y));
    if (value) dropPortalsAt(inside);
    for (const [x, y] of inside) editor.edgemap[y][x] = value;
}

/** Lay or lift kelp, on this boundary and the one it mirrors onto. */
function setEdge(x: number, y: number, value: EdgeValue) {
    writeEdges(mirroredEdges(x, y), value);
}

/**
 * The value a kelp paint would write right now. Modifiers are quick overrides
 * for the panel's brush: shift draws, ctrl erases.
 */
export function brushValue(mods: Modifiers = NO_MODIFIERS): EdgeValue {
    if (mods.shift) return true;
    if (mods.ctrl) return false;
    return editor.drawMode === "draw";
}

/**
 * The boundaries a paint at `target` writes to.
 */
export function targetEdges(target: Target): [number, number][] {
    return target.kind === "edge" ? [[target.x, target.y]] : [];
}

/** Every boundary a paint changes, deduplicated. The hover ghost previews these. */
export function affectedEdges(target: Target): [number, number][] {
    return target.kind === "edge" ? mirroredEdges(target.x, target.y).filter(([x, y]) => edgeInRange(x, y)) : [];
}

export interface DragonBoard {
    edgemap: EdgeValue[][];
    portals: [PortalEnd, PortalEnd][];
    dragons: EditorDragon[];
}

export function brokenDragons(board: DragonBoard): EditorDragon[] {
    const partners = new Map<string, PortalEnd>();
    for (const [a, b] of board.portals) {
        partners.set(String(a), b);
        partners.set(String(b), a);
    }
    const wrap = (n: number, size: number) => (n + size) % size;
    function neighbours([x, y]: PortalEnd): PortalEnd[] {
        const result: PortalEnd[] = [];
        for (const [dx, dy] of [
            [0, -1],
            [0, 1],
            [-1, 0],
            [1, 0],
        ]) {
            const edge: PortalEnd = dy
                ? [x, 2 * wrap(y + Math.max(dy, 0), editor.h)]
                : [wrap(x + Math.max(dx, 0), editor.w), 2 * y + 1];
            if (board.edgemap[edge[1]][edge[0]]) continue;
            const other = partners.get(String(edge));
            result.push(
                other
                    ? [
                          wrap(other[0] - (dx < 0 ? 1 : 0), editor.w),
                          wrap(Math.floor(other[1] / 2) - (dy < 0 ? 1 : 0), editor.h),
                      ]
                    : [wrap(x + dx, editor.w), wrap(y + dy, editor.h)],
            );
        }
        return result;
    }
    return board.dragons.filter((dragon) =>
        dragon.body
            .slice(1)
            .some((tail, i) => !neighbours(tail).some((head) => String(head) === String(dragon.body[i]))),
    );
}

/** Why this paint can't be made, or undefined when it can. */
export function placementIssue(target: Target, mods: Modifiers = NO_MODIFIERS): string | undefined {
    if (!brushValue(mods)) {
        const inside = target.kind === "tile" ? tileInRange(target.x, target.y) : edgeInRange(target.x, target.y);
        return inside ? undefined : "Outside the board";
    }
    if (editor.brushType === "pearl" || editor.brushType === "dragon") {
        return tileInRange(target.x, target.y) ? undefined : "Outside the board";
    }
    const edges = targetEdges(target);
    if (edges.some(([x, y]) => !edgeInRange(x, y))) return "Outside the board";
    if (editor.brushType === "kelp" && cutsADragon(target)) return "Kelp would cut a dragon in two";
    if (editor.brushType === "portal") {
        if (edges.length !== 1) return "Pick a single boundary for a portal";
        const [[x, y]] = edges;
        if (editor.edgemap[y][x]) return "Clear the kelp here first";
        if (editor.pendingPortal && sameCell(editor.pendingPortal, [x, y])) return undefined;
        if (editor.pendingPortal && !portalAligned(editor.pendingPortal, [x, y])) {
            return `Both portals must be ${edgeAxis(editor.pendingPortal[1])}`;
        }

        if (editor.pendingPortal && onAxis(...editor.pendingPortal) !== onAxis(x, y)) {
            return "Either both ends must be on the axis of symmetry, or neither";
        }
        if (editor.portals.some((pair) => pair.some((end) => sameCell(end, [x, y])))) return "Already a portal";
    }
    return undefined;
}

/** Kelp here would sever a dragon that is whole right now. */
function cutsADragon(target: Target): boolean {
    const edges = affectedEdges(target);
    if (!edges.length || !editor.dragons.length) return false;
    const id = (dragon: EditorDragon) => JSON.stringify(dragon);
    const alreadyBroken = new Set(brokenDragons(editor).map(id));
    const edgemap = editor.edgemap.map((row) => row.slice());
    for (const [x, y] of edges) edgemap[y][x] = true;
    return brokenDragons({ edgemap, portals: editor.portals, dragons: editor.dragons }).some(
        (dragon) => !alreadyBroken.has(id(dragon)),
    );
}

function paintPortal(x: number, y: number): void {
    const pending = editor.pendingPortal;
    if (!pending) {
        editor.pendingPortal = [x, y];
        return;
    }
    if (sameCell(pending, [x, y])) {
        editor.pendingPortal = undefined;
        return;
    }
    addPortalPair(pending, [x, y]);
    editor.pendingPortal = undefined;
}

function addPortalPair(a: PortalEnd, b: PortalEnd): void {
    const pairs: [PortalEnd, PortalEnd][] = [
        [a, b],
        [mirrorEdge(a[0], a[1]), mirrorEdge(b[0], b[1])],
    ];
    dropPortalsAt(pairs.flat());

    for (const pair of pairs) {
        const [from, to] = pair;
        if (sameCell(from, to)) continue;
        if (!portalAligned(from, to)) continue;
        if (!edgeInRange(from[0], from[1]) || !edgeInRange(to[0], to[1])) continue;
        if (editor.portals.some((glued) => glued.some((slot) => pair.some((end) => sameCell(slot, end))))) continue;
        editor.portals.push(pair);
    }
}

function eraseDragonAt(x: number, y: number): void {
    const inDraft = editor.dragonDraft.findIndex(([dx, dy]) => dx === x && dy === y);
    if (inDraft !== -1) {
        editor.dragonDraft = editor.dragonDraft.slice(0, inDraft);
        return;
    }
    const index = editor.dragons.findIndex((dragon) => dragon.body.some(([bx, by]) => bx === x && by === y));
    if (index !== -1) removeDragon(index);
}

/** Unglue the portal here and the one its mirror belongs to. */
function dropPortalMirrored(x: number, y: number): void {
    dropPortalsAt(mirroredEdges(x, y));
}

function paintPearls(x: number, y: number, bounds: PearlRespawnBounds): void {
    for (const [mx, my] of mirroredTiles(x, y)) {
        if (tileInRange(mx, my)) editor.pearls[my][mx] = { ...bounds };
    }
}

/** Apply the current brush at `target`. A no-op if it can't be placed. */
export function paint(target: Target, mods: Modifiers = NO_MODIFIERS): void {
    if (placementIssue(target, mods)) return;

    if (!brushValue(mods)) {
        eraseAt(target);
        return;
    }
    if (editor.brushType === "pearl") {
        paintPearls(target.x, target.y, editor.pearlBrush);
        return;
    }
    if (editor.brushType === "dragon") {
        extendDragonDraft(target.x, target.y);
        return;
    }
    if (editor.brushType === "portal") {
        paintPortal(target.x, target.y);
        return;
    }
    if (target.kind === "edge") setEdge(target.x, target.y, true);
}

/**
 *  Erase whatever the brush draws. Every layer but `all` pins the brush, so
 *  this follows the layer there. `all` pins nothing and shows everything, so
 *  there it takes whatever is under the pointer rather than only the brush.
 *  Pearl beds are erased only when their density overlay is visible.
 */
function eraseAt(target: Target): void {
    const all = editor.layer === "all";

    if (target.kind === "edge") {
        const { x, y } = target;
        if (all || editor.brushType === "kelp") setEdge(x, y, false);
        if (all || editor.brushType === "portal") dropPortalMirrored(x, y);
        return;
    }

    if (!tileInRange(target.x, target.y)) return;
    if (pearlsVisible()) paintPearls(target.x, target.y, noPearls());
    if (all || editor.brushType === "dragon") eraseDragonAt(target.x, target.y);
}

function isNeighbour(a: [number, number], b: [number, number]): boolean {
    const dx = Math.abs(a[0] - b[0]);
    const dy = Math.abs(a[1] - b[1]);
    const wrapX = dx === editor.w - 1;
    const wrapY = dy === editor.h - 1;
    return (dy === 0 && (dx === 1 || wrapX)) || (dx === 0 && (dy === 1 || wrapY));
}

function occupiedCells(): Set<string> {
    const cells = new Set<string>();
    for (const dragon of editor.dragons) for (const [x, y] of dragon.body) cells.add(`${x},${y}`);
    for (const [x, y] of editor.dragonDraft) cells.add(`${x},${y}`);
    return cells;
}

/** Add a cell to the dragon being drawn; the first click places the head. */
export function extendDragonDraft(x: number, y: number): void {
    const [mx, my] = mirrorTile(x, y);
    if (mx === x && my === y) return;
    const taken = occupiedCells();
    if (taken.has(`${x},${y}`) || taken.has(`${mx},${my}`)) return;
    const last = editor.dragonDraft[editor.dragonDraft.length - 1];
    if (last && !isNeighbour(last, [x, y])) return;
    editor.dragonDraft.push([x, y]);
}

/** The same dragon seen in the mirror, which is the other team's spawn. */
export function mirrorDragon(dragon: EditorDragon): EditorDragon {
    return {
        team: dragon.team === 0 ? 1 : 0,
        body: dragon.body.map(([x, y]) => mirrorTile(x, y)),
    };
}

/**
 * Turn the draft into a dragon, and its mirror into the other team's.
 */
export function commitDragonDraft(): string | undefined {
    if (editor.dragonDraft.length < 2) return "A dragon needs at least two cells";
    const dragon: EditorDragon = { team: editor.nextDragonTeam, body: [...editor.dragonDraft] };
    const mirrored = mirrorDragon(dragon);
    const cells = new Set(dragon.body.map(([x, y]) => `${x},${y}`));
    const crosses = mirrored.body.some(([x, y]) => cells.has(`${x},${y}`));
    editor.dragonDraft = [];
    if (crosses) return "A dragon and its mirror would cross";
    editor.dragons.push(dragon, mirrored);
    return undefined;
}

export function cancelDragonDraft(): void {
    editor.dragonDraft = [];
}

export function removeDragon(index: number): void {
    const dragon = editor.dragons[index];
    if (!dragon) return;
    const mirrored = mirrorDragon(dragon);
    editor.dragons = editor.dragons.filter((candidate) => candidate !== dragon && !sameDragon(candidate, mirrored));
}

/** Do these two describe the same dragon, cell for cell? */
function sameDragon(a: EditorDragon, b: EditorDragon): boolean {
    return a.team === b.team && a.body.length === b.body.length && a.body.every((cell, i) => sameCell(cell, b.body[i]));
}

export function dragonPairs(): { indices: number[]; dragons: EditorDragon[] }[] {
    const groups: { indices: number[]; dragons: EditorDragon[] }[] = [];
    const taken = new Set<number>();
    editor.dragons.forEach((dragon, index) => {
        if (taken.has(index)) return;
        taken.add(index);
        const mirrored = mirrorDragon(dragon);
        const partner = editor.dragons.findIndex((other, i) => !taken.has(i) && sameDragon(other, mirrored));
        if (partner === -1) {
            groups.push({ indices: [index], dragons: [dragon] });
            return;
        }
        taken.add(partner);
        groups.push({ indices: [index, partner], dragons: [dragon, editor.dragons[partner]] });
    });
    return groups;
}

/**
 * View preferences and sidebar hover state, not part of the map file.
 */
export const editorUi = $state({ hoveredDragons: [] as number[], showPearlDensity: false });

/** Shared by rendering, erasing and selection so hidden beds stay untouched. */
export function pearlsVisible(): boolean {
    return editor.layer === "pearls" || (editor.layer === "all" && editorUi.showPearlDensity);
}

// Settle the pearl brush's range once a field is done being edited.
export function commitPearlBound(which: "minRounds" | "maxRounds"): void {
    const bounds = editor.pearlBrush;
    bounds.minRounds = Math.max(0, Math.floor(bounds.minRounds) || 0);
    bounds.maxRounds = Math.max(0, Math.floor(bounds.maxRounds) || 0);
    if (bounds.minRounds <= bounds.maxRounds) return;
    if (which === "minRounds") bounds.maxRounds = bounds.minRounds;
    else bounds.minRounds = bounds.maxRounds;
}

/** Give every tile the brush's respawn bounds. */
export function fillPearls(bounds: PearlRespawnBounds = editor.pearlBrush): void {
    editor.pearls = pearlGrid(editor.w, editor.h, bounds);
}

// Empty the board completely
export function clearBoard(): void {
    editor.edgemap = emptyEdges(editor.w, editor.h);
    fillPearls(noPearls());
    editor.portals = [];
    editor.pendingPortal = undefined;
    editor.dragons = [];
    editor.dragonDraft = [];
}

// Resize the board (which also clears it)
export function setBoardSize(which: "w" | "h", size: number): void {
    if (editor[which] === size) return;
    editor[which] = size;
    clearBoard();
}

// Switch symmetry and clear board
export function setSymmetry(symm: Symmetry): void {
    if (editor.symm === symm) return;
    editor.symm = symm;
    clearBoard();
}

/** Each wrapped outer boundary, using only its top/left slot. */
function borderEdges(): PortalEnd[] {
    const { w, h } = editor;
    const edges: PortalEnd[] = [];
    for (let x = 0; x < w; x++) {
        edges.push([x, 0]);
    }
    for (let y = 1; y < 2 * h; y += 2) {
        edges.push([0, y]);
    }
    return edges;
}

/** Kelp off the outside of the board, or clear it when it's already kelped. */
export function toggleBorders() {
    const border = borderEdges();
    // One decision for the whole ring rather than flipping each edge, so a
    // partly-kelped border completes instead of inverting into holes.
    const value = !border.every(([x, y]) => editor.edgemap[y][x] === true);
    // The full border already includes all mirrors.
    writeEdges(border, value);
}

/** Edgemap coordinate -> the boundary the rest of the package understands. */
export function toBoardEdge(x: number, y: number): Edge {
    return y % 2 === 0 ? { x, y: y / 2, side: "N" } : { x, y: (y - 1) / 2, side: "W" };
}

/**
 * Which board elements to include. Leaving one out builds the same board
 * without it, which is how the layer view renders one element type on its own.
 */
export interface MapParts {
    kelp?: boolean;
    portals?: boolean;
}

/**
 * The editor's state as a map. Rendering and text export both go through this,
 * so there is one description of the board rather than one per consumer.
 */
export function editorStaticMap(parts: MapParts = {}): StaticMap {
    const { kelp: withKelp = true, portals: withPortals = true } = parts;
    const { w, h } = editor;

    const hEdges = new Uint8Array((h + 1) * w);
    const vEdges = new Uint8Array(h * (w + 1));
    if (withKelp) {
        for (let by = 0; by < h; by++) {
            for (let x = 0; x < w; x++) {
                if (editor.edgemap[2 * by][x]) hEdges[by * w + x] = EdgeTile.Kelp;
            }
        }
        for (let y = 0; y < h; y++) {
            for (let bx = 0; bx < w; bx++) {
                if (editor.edgemap[2 * y + 1][bx]) vEdges[y * (w + 1) + bx] = EdgeTile.Kelp;
            }
        }
    }

    const portals = withPortals
        ? editor.portals.map(([a, b]) => [toBoardEdge(a[0], a[1]), toBoardEdge(b[0], b[1])] as [Edge, Edge])
        : [];
    for (const [a, b] of portals) {
        for (const edge of [a, b]) {
            if (edge.side === "N") hEdges[edge.y * w + edge.x] = EdgeTile.Portal;
            else vEdges[edge.y * (w + 1) + edge.x] = EdgeTile.Portal;
        }
    }

    const pearlRespawn: PearlRespawnBounds[] = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) pearlRespawn.push({ ...editor.pearls[y][x] });
    }

    const dragons = editor.dragons.map((dragon, id) => {
        const body = dragon.body.map(([x, y]) => ({ x, y }));
        return {
            id,
            team: dragon.team === 0 ? ("A" as const) : ("B" as const),
            facing: dragonFacing(body, w, h),
            body,
        };
    });

    return new StaticMap(
        w,
        h,
        new Uint8Array(w * h),
        hEdges,
        vEdges,
        portals,
        dragons,
        pearlRespawn,
        editor.unitLimit,
        editor.symm,
        editor.name.trim() || undefined,
    );
}

/** The full, valid .map file text for the editor's current state. */
export function buildMapText(map: StaticMap = editorStaticMap()): string {
    return serializeMapText(map, { canonicalEdgesOnly: true });
}

/** Load a .map file, padding small boards to MIN_SIZE and rejecting oversized boards. */
export function importMapText(text: string): void {
    const map = StaticMap.fromMapText(text);
    if (map.width > MAX_SIZE || map.height > MAX_SIZE) {
        throw new Error(`Map dimensions must be at most ${MAX_SIZE} by ${MAX_SIZE}`);
    }

    editor.w = clamp(map.width, MIN_SIZE, MAX_SIZE);
    editor.h = clamp(map.height, MIN_SIZE, MAX_SIZE);
    editor.unitLimit = map.unitLimit;
    if (map.mapName) editor.name = map.mapName;
    // Files from before symmetry was recorded keep whatever the editor had.
    // The board isn't checked against it: an asymmetric board loads as is.
    if (map.symmetry) editor.symm = map.symmetry;

    clearBoard();
    for (let by = 0; by <= map.height; by++) {
        for (let x = 0; x < map.width; x++) {
            if (map.initialHEdges[by * map.width + x] === EdgeTile.Kelp) {
                const [ex, ey] = canonicalEdge(x, 2 * by, map.width, map.height);
                editor.edgemap[ey][ex] = true;
            }
        }
    }
    for (let y = 0; y < map.height; y++) {
        for (let bx = 0; bx <= map.width; bx++) {
            if (map.initialVEdges[y * (map.width + 1) + bx] === EdgeTile.Kelp) {
                const [ex, ey] = canonicalEdge(bx, 2 * y + 1, map.width, map.height);
                editor.edgemap[ey][ex] = true;
            }
        }
    }

    // Older files may list both copies of a wrapped portal. Keep one pair.
    for (const ends of map.portals) {
        const pair = ends.map((edge) => canonicalEdge(...portalEndOf(edge), map.width, map.height)) as [
            PortalEnd,
            PortalEnd,
        ];
        if (sameCell(pair[0], pair[1]) || editor.portals.some((stored) => sameSlots(stored, pair))) continue;
        editor.portals.push(pair);
        for (const [x, y] of pair) editor.edgemap[y][x] = false;
    }

    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            editor.pearls[y][x] = { ...map.pearlRespawn[y * map.width + x] };
        }
    }

    editor.dragons = map.initialDragons.map((dragon) => ({
        team: dragon.team === "A" ? 0 : 1,
        body: dragon.body.map((cell) => [cell.x, cell.y] as [number, number]),
    }));
}

function portalEndOf(edge: { x: number; y: number; side: string }): PortalEnd {
    return edge.side === "N" ? [edge.x, 2 * edge.y] : [edge.x, 2 * edge.y + 1];
}
