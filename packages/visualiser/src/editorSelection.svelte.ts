// Rectangular selection and an internal object clipboard. Placement is atomic:
// work on a detached map, check collisions, then publish one history entry.
import {
    editor,
    editorUi,
    mirrorTile,
    mirrorEdge,
    mirrorDragon,
    brokenDragons,
    pearlsVisible,
    type EditorDragon,
    type PortalEnd,
} from "./mapEditor.svelte";
import type { PearlRespawnBounds } from "./visualiser/Map";
import { edit } from "./editorHistory.svelte";

export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Objects {
    bounds: Rectangle;
    kelp: PortalEnd[];
    portals: [PortalEnd, PortalEnd][];
    pearls: { at: PortalEnd; bounds: PearlRespawnBounds }[];
    dragons: EditorDragon[];
}

export const selection = $state({
    tool: "paint" as "paint" | "select",
    rectangle: undefined as Rectangle | undefined,
    clipboard: undefined as Objects | undefined,
    pasting: false,
    message: "",
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const key = (value: unknown) => JSON.stringify(value);
const pairKey = (pair: [PortalEnd, PortalEnd]) => pair.map(key).sort().join(";");
const mirrorPair = (pair: [PortalEnd, PortalEnd]): [PortalEnd, PortalEnd] =>
    pair.map(([x, y]) => mirrorEdge(x, y)) as [PortalEnd, PortalEnd];

export function rectangleBetween(a: PortalEnd, b: PortalEnd): Rectangle {
    return {
        x: Math.min(a[0], b[0]),
        y: Math.min(a[1], b[1]),
        width: Math.abs(a[0] - b[0]) + 1,
        height: Math.abs(a[1] - b[1]) + 1,
    };
}

export function contains(rect: Rectangle, x: number, y: number): boolean {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function containsEdge(rect: Rectangle, [x, row]: PortalEnd): boolean {
    const y = Math.floor(row / 2);
    return (
        x >= rect.x &&
        y >= rect.y &&
        (row % 2 === 0
            ? x < rect.x + rect.width && y <= rect.y + rect.height
            : x <= rect.x + rect.width && y < rect.y + rect.height)
    );
}

// When both halves are selected, take one representative per mirrored object.
function representatives<T>(items: T[], mirror: (item: T) => T, id: (item: T) => string = key): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (seen.has(id(item))) return false;
        seen.add(id(item));
        seen.add(id(mirror(item)));
        return true;
    });
}

export function selectedObjects(): Objects | undefined {
    const rect = selection.rectangle;
    if (!rect) return undefined;
    const all = editor.layer === "all";
    const kelp: PortalEnd[] = [];
    if (all || editor.layer === "kelp") {
        editor.edgemap.forEach((row, y) =>
            row.forEach((value, x) => {
                if (value && containsEdge(rect, [x, y])) kelp.push([x, y]);
            }),
        );
    }
    const pearls: Objects["pearls"] = [];
    if (pearlsVisible()) {
        editor.pearls.forEach((row, y) =>
            row.forEach((bounds, x) => {
                if (bounds.maxRounds > 0 && contains(rect, x, y)) pearls.push({ at: [x, y], bounds: { ...bounds } });
            }),
        );
    }
    return clone({
        bounds: rect,
        kelp: representatives(kelp, ([x, y]) => mirrorEdge(x, y)),
        portals: representatives(
            all || editor.layer === "portals"
                ? editor.portals.filter((pair) => pair.every((end) => containsEdge(rect, end)))
                : [],
            mirrorPair,
            pairKey,
        ),
        pearls: representatives(
            pearls,
            (pearl) => ({ ...pearl, at: mirrorTile(...pearl.at) }),
            (pearl) => key(pearl.at),
        ),
        dragons: representatives(
            all || editor.layer === "dragons"
                ? editor.dragons.filter((dragon) => dragon.body.every(([x, y]) => contains(rect, x, y)))
                : [],
            mirrorDragon,
        ),
    });
}

export function selectedCount(): number {
    const objects = selectedObjects();
    return objects ? objects.kelp.length + objects.portals.length + objects.pearls.length + objects.dragons.length : 0;
}

export function clearSelection(): void {
    selection.rectangle = undefined;
    selection.pasting = false;
    selection.message = "";
}

export function setTool(tool: "paint" | "select"): void {
    selection.tool = tool;
    editor.dragonDraft = [];
    editor.pendingPortal = undefined;
    clearSelection();
}

type Board = Pick<typeof editor, "edgemap" | "pearls" | "portals" | "dragons">;
function remove(board: Board, objects: Objects): void {
    for (const at of objects.kelp) for (const [x, y] of [at, mirrorEdge(...at)]) board.edgemap[y][x] = false;
    for (const { at } of objects.pearls)
        for (const [x, y] of [at, mirrorTile(...at)]) {
            board.pearls[y][x] = { minRounds: 0, maxRounds: 0 };
        }
    const portals = new Set(objects.portals.flatMap((pair) => [pairKey(pair), pairKey(mirrorPair(pair))]));
    board.portals = board.portals.filter((pair) => !portals.has(pairKey(pair)));
    const dragons = new Set(objects.dragons.flatMap((dragon) => [key(dragon), key(mirrorDragon(dragon))]));
    board.dragons = board.dragons.filter((dragon) => !dragons.has(key(dragon)));
}

export function copySelection(cut = false): void {
    const objects = selectedObjects();
    if (!objects || !selectedCount()) {
        selection.message = "Select some complete objects first.";
        return;
    }
    selection.clipboard = objects;
    if (cut) edit(() => remove(editor, objects));
    selection.message = cut ? "Cut. Paste, then click a destination." : "Copied. Paste, then click a destination.";
}

export function deleteSelection(): void {
    const objects = selectedObjects();
    if (objects) edit(() => remove(editor, objects));
}

export function startPaste(): void {
    if (!selection.clipboard) return;
    selection.tool = "select";
    selection.pasting = true;
    editor.dragonDraft = [];
    editor.pendingPortal = undefined;
    selection.message = "Click to place the top-left corner. Escape cancels.";
}

type Placement = { board: Board; bounds: Rectangle } | { error: string; cells: PortalEnd[] };

const edgeTile = ([x, row]: PortalEnd): PortalEnd => [x, Math.floor(row / 2)];

function attempt(x: number, y: number, paste: boolean): Placement {
    const source = paste ? selection.clipboard : selectedObjects();
    if (!source) return { error: "", cells: [] };
    const dx = paste ? x - source.bounds.x : x;
    const dy = paste ? y - source.bounds.y : y;
    const bounds = { ...source.bounds, x: source.bounds.x + dx, y: source.bounds.y + dy };
    const fail = (message: string, cells: PortalEnd[] = []): Placement => ({ error: message, cells });
    if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > editor.w || bounds.y + bounds.height > editor.h)
        return fail("The selection must fit inside the board.");
    const board: Board = clone({
        edgemap: editor.edgemap,
        pearls: editor.pearls,
        portals: editor.portals,
        dragons: editor.dragons,
    });
    if (!paste) remove(board, source);
    const shiftTile = ([x, y]: PortalEnd): PortalEnd => [x + dx, y + dy];
    const shiftEdge = ([x, y]: PortalEnd): PortalEnd => [x + dx, y + 2 * dy];
    const edgeInside = ([x, y]: PortalEnd) => x >= 0 && x < editor.w && y >= 0 && y < 2 * editor.h;
    const portalEnds = new Set(board.portals.flat().map(key));
    const clashes: PortalEnd[] = [];
    for (const at of source.kelp.map(shiftEdge)) {
        if (!edgeInside(at)) return fail("An edge would land on the hidden bottom/right boundary.");
        for (const [x, y] of [at, mirrorEdge(...at)]) {
            if (portalEnds.has(key([x, y]))) clashes.push(edgeTile([x, y]));
            else board.edgemap[y][x] = true;
        }
    }
    if (clashes.length) return fail("Kelp would overlap an existing portal.", clashes);
    const newPairs = source.portals.map((pair) => pair.map(shiftEdge) as [PortalEnd, PortalEnd]);
    const placedPairs = new Set<string>();
    for (const pair of newPairs) {
        if (!pair.every(edgeInside)) return fail("A portal would land on the hidden bottom/right boundary.");
        for (const placed of [pair, mirrorPair(pair)]) {
            if (placedPairs.has(pairKey(placed))) continue;
            const hits =
                key(placed[0]) === key(placed[1])
                    ? placed
                    : placed.filter(([x, y]) => board.edgemap[y][x] || portalEnds.has(key([x, y])));
            if (hits.length) {
                clashes.push(...hits.map(edgeTile));
                continue;
            }
            placedPairs.add(pairKey(placed));
            placed.forEach((end) => portalEnds.add(key(end)));
            board.portals.push(placed);
        }
    }
    if (clashes.length) return fail("A portal or its mirror would overlap kelp or another portal.", clashes);
    const pearlWrites = new Map<string, PearlRespawnBounds>();
    for (const pearl of source.pearls) {
        const at = shiftTile(pearl.at);
        for (const [x, y] of [at, mirrorTile(...at)]) {
            const previous = pearlWrites.get(key([x, y]));
            if (previous && key(previous) !== key(pearl.bounds)) {
                clashes.push([x, y]);
                continue;
            }
            pearlWrites.set(key([x, y]), pearl.bounds);
            board.pearls[y][x] = { ...pearl.bounds };
        }
    }
    if (clashes.length) return fail("Mirrored pearl beds would have conflicting densities.", clashes);
    const occupied = new Set(board.dragons.flatMap((dragon) => dragon.body.map(key)));
    const placedDragons = new Set<string>();
    for (const dragon of source.dragons) {
        const shifted = { ...dragon, body: dragon.body.map(shiftTile) };
        for (const placed of [shifted, mirrorDragon(shifted)]) {
            if (placedDragons.has(key(placed))) continue;
            const hits = placed.body.filter((point) => occupied.has(key(point)));
            if (hits.length) {
                clashes.push(...hits);
                continue;
            }
            placedDragons.add(key(placed));
            placed.body.forEach((point) => occupied.add(key(point)));
            board.dragons.push(placed);
        }
    }
    if (clashes.length) return fail("A dragon or its mirror would overlap another dragon.", clashes);
    // Only a dragon this placement breaks stands in its way; one that was already
    // broken elsewhere on the board is not this move's business.
    const excused = new Set(
        brokenDragons({ edgemap: editor.edgemap, portals: editor.portals, dragons: editor.dragons }).map(key),
    );
    if (!paste)
        for (const dragon of source.dragons) {
            if (!excused.has(key(dragon))) continue;
            const moved = { ...dragon, body: dragon.body.map(shiftTile) };
            for (const placed of [moved, mirrorDragon(moved)]) excused.add(key(placed));
        }
    for (const dragon of brokenDragons(board)) if (!excused.has(key(dragon))) clashes.push(...dragon.body);
    if (clashes.length) return fail("This placement would disconnect a dragon or put kelp through its body.", clashes);
    return { board, bounds };
}

/** Move by tile offsets, or paste the clipboard with its top-left at (x, y). */
export function placeSelection(x: number, y: number, paste = false): boolean {
    const placement = attempt(x, y, paste);
    if ("error" in placement) {
        if (placement.error) selection.message = placement.error;
        return false;
    }
    edit(() => Object.assign(editor, placement.board));
    editorUi.hoveredDragons = [];
    selection.rectangle = placement.bounds;
    selection.pasting = false;
    selection.message = paste ? "Pasted." : "Moved.";
    return true;
}

/** Whether `placeSelection` would be accepted here, and the tiles that stop it. */
export function placementReview(x: number, y: number, paste = false): { legal: boolean; conflicts: PortalEnd[] } {
    const placement = attempt(x, y, paste);
    return "error" in placement ? { legal: false, conflicts: placement.cells } : { legal: true, conflicts: [] };
}

/** The selection as it would sit at the destination, mirrored partners included. */
export function placementGhost(x: number, y: number, paste = false): Objects | undefined {
    const source = paste ? selection.clipboard : selectedObjects();
    if (!source) return undefined;
    const dx = paste ? x - source.bounds.x : x;
    const dy = paste ? y - source.bounds.y : y;
    const shiftTile = ([x, y]: PortalEnd): PortalEnd => [x + dx, y + dy];
    const shiftEdge = ([x, y]: PortalEnd): PortalEnd => [x + dx, y + 2 * dy];
    const kelp = source.kelp.map(shiftEdge);
    const portals = source.portals.map((pair) => pair.map(shiftEdge) as [PortalEnd, PortalEnd]);
    const pearls = source.pearls.map((pearl) => ({ ...pearl, at: shiftTile(pearl.at) }));
    const dragons = source.dragons.map((dragon) => ({ ...dragon, body: dragon.body.map(shiftTile) }));
    return {
        bounds: { ...source.bounds, x: source.bounds.x + dx, y: source.bounds.y + dy },
        kelp: [...kelp, ...kelp.map(([x, y]) => mirrorEdge(x, y))],
        portals: [...portals, ...portals.map(mirrorPair)],
        pearls: [...pearls, ...pearls.map((pearl) => ({ ...pearl, at: mirrorTile(...pearl.at) }))],
        dragons: [...dragons, ...dragons.map(mirrorDragon)],
    };
}
