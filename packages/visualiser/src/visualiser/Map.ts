// Board state. `StaticMap` holds the immutable map data parsed from a .map
// file; `CurrentMap` is the mutable per-round view.

import { EdgeTile, Tile, type GameEvent, type DragonData } from "./Schema";
import { movePoint, type BoardSize, type Direction, type Vector } from "./Vector";

/**
 * Which way a map mirrors onto itself: `x` flips top to bottom, `y` left to
 * right, `xy` both (a half turn).
 */
export type MapSymmetry = "x" | "y" | "xy";

const SYMMETRIES: readonly MapSymmetry[] = ["x", "y", "xy"];

/** A cell boundary. */
export interface Edge {
    x: number;
    y: number;
    side: Direction;
}

/** Bottom/right copies are hidden when displaying a wrapped board. */
export function isDuplicateTorusEdge(edge: Edge, map: { width: number; height: number }): boolean {
    return (
        (edge.side === "N" && edge.y === map.height) ||
        (edge.side === "S" && edge.y + 1 === map.height) ||
        (edge.side === "W" && edge.x === map.width) ||
        (edge.side === "E" && edge.x + 1 === map.width)
    );
}

/**
 * Canonical key for an edge: the same physical boundary has the same key
 * from either side. H keys use the boundary row; V keys use the boundary column.
 */
export function edgeKey(edge: Edge): string {
    switch (edge.side) {
        case "N":
            return `H:${edge.x},${edge.y}`;
        case "S":
            return `H:${edge.x},${edge.y + 1}`;
        case "W":
            return `V:${edge.x},${edge.y}`;
        case "E":
            return `V:${edge.x + 1},${edge.y}`;
    }
}

/** Same physical boundary? */
export function sameEdge(a: Edge, b: Edge): boolean {
    return edgeKey(a) === edgeKey(b);
}

/**
 * Which side of `cell` this edge lies on, or undefined. With a board size,
 * top/left edges also match the equivalent bottom/right side of the torus.
 */
export function edgeSideOf(edge: Edge, cell: Vector, board?: BoardSize): Direction | undefined {
    if (edge.x === cell.x && edge.y === cell.y) return edge.side;
    switch (edge.side) {
        case "N":
            if (edge.x === cell.x && edge.y - 1 === cell.y) return "S";
            break;
        case "S":
            if (edge.x === cell.x && edge.y + 1 === cell.y) return "N";
            break;
        case "W":
            if (edge.x - 1 === cell.x && edge.y === cell.y) return "E";
            break;
        case "E":
            if (edge.x + 1 === cell.x && edge.y === cell.y) return "W";
            break;
    }
    if (!board || !Number.isFinite(board.width) || !Number.isFinite(board.height)) return undefined;
    const wanted = wrappedEdgeKey(edge, board.width, board.height);
    for (const side of ["N", "E", "S", "W"] as const) {
        if (wrappedEdgeKey({ x: cell.x, y: cell.y, side }, board.width, board.height) === wanted) return side;
    }
    return undefined;
}

/**
 * Direction one leaves `from` by to reach `to` through a portal pair.
 * Undefined when no portal connects the two.
 */
export function portalDirection(
    portals: readonly (readonly [Edge, Edge])[],
    from: Vector,
    to: Vector,
    board?: BoardSize,
): Direction | undefined {
    for (const [a, b] of portals) {
        const out = edgeSideOf(a, from, board);
        if (out !== undefined && edgeSideOf(b, to, board) !== undefined) return out;
        const back = edgeSideOf(b, from, board);
        if (back !== undefined && edgeSideOf(a, to, board) !== undefined) return back;
    }
    return undefined;
}

/**
 * The unique identifier of an edge (to deal with symmetry, shared edges, and borders)
 */
export function wrappedEdgeKey(edge: Edge, width: number, height: number): string {
    const key = edgeKey(edge);
    const [kind, coordinates] = key.split(":");
    const [a, b] = coordinates.split(",").map(Number);
    if (kind === "H" && b === height) return `H:${a},0`;
    if (kind === "V" && a === width) return `V:0,${b}`;
    return key;
}

/**
 * A replay keeps its .map file verbatim, so one recorded before the dragon
 * rename still spells the body keywords SNAKE. Reading takes either; only the
 * new spelling is ever written back out.
 */
const RENAMED: Record<string, string> = { SNAKE: "DRAGON", SNAKE_COUNT: "DRAGON_COUNT" };

/** Immutable map data and initial dragons. */
export class StaticMap {
    public readonly portalMap: Map<string, Edge>;
    public readonly portalLabels: number[];

    constructor(
        public readonly width: number,
        public readonly height: number,
        /** Round-0 tile map. */
        public readonly initialTiles: Uint8Array,
        /** Round-0 horizontal boundaries. */
        public readonly initialHEdges: Uint8Array,
        /** Round-0 vertical boundaries. */
        public readonly initialVEdges: Uint8Array,
        /** Glued portal edge pairs, in portal-id order. */
        public readonly portals: [Edge, Edge][],
        /** Round-0 dragons, in spawn order. */
        public readonly initialDragons: DragonData[],
        /** Per-tile pearl respawn bounds; 0..0 means the tile never spawns. */
        public readonly pearlRespawn: PearlRespawnBounds[],
        public readonly unitLimit?: number,
        public readonly symmetry?: MapSymmetry,
        public readonly mapName?: string,
    ) {
        this.portalMap = new Map();
        for (const [a, b] of portals) {
            this.portalMap.set(wrappedEdgeKey(a, width, height), b);
            this.portalMap.set(wrappedEdgeKey(b, width, height), a);
        }

        const firstOfPortal = new Map<string, number>();
        this.portalLabels = portals.map(([a, b], index) => {
            const ends = [wrappedEdgeKey(a, width, height), wrappedEdgeKey(b, width, height)].sort().join("|");
            const first = firstOfPortal.get(ends);
            if (first !== undefined) return first;
            firstOfPortal.set(ends, index);
            return index;
        });
    }

    inBounds(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.width && y < this.height;
    }

    locationToIndex(x: number, y: number): number {
        return y * this.width + x;
    }

    indexToLocation(index: number): Vector {
        return { x: index % this.width, y: Math.floor(index / this.width) };
    }

    mirrorTile(x: number, y: number): Vector {
        switch (this.symmetry) {
            case "x":
                return { x, y: this.height - 1 - y };
            case "y":
                return { x: this.width - 1 - x, y };
            case "xy":
                return { x: this.width - 1 - x, y: this.height - 1 - y };
            default:
                return { x, y };
        }
    }

    /**
     * Parse the engine's `.map` file, one counted section per keyword:
     *
     *   MAP w h · UNIT_LIMIT n, SYMMETRY x|y|xy and MAP_NAME text (all optional)
     *   TILE_COUNT n, then `TILE x y minRounds maxRounds` per tile
     *   EDGE_COUNT n, then `EDGE id type portalId` per boundary; one in two
     *     portals (see `portalLabels`) is listed once per portal
     *   DRAGON_COUNT n, then `DRAGON team segments x1 y1 ...` head first
     *   END
     *
     * Edge ids run row-major over the (w+1) x (2h+1) boundary grid: even rows
     * hold the boundary above each tile row, odd rows the boundaries between
     * tiles in that row.
     */
    static fromMapText(text: string): StaticMap {
        let width = 0;
        let height = 0;
        let unitLimit: number | undefined;
        let symmetry: MapSymmetry | undefined;
        let mapName: string | undefined;
        let tiles = new Uint8Array(0);
        let hEdges = new Uint8Array(0);
        let vEdges = new Uint8Array(0);
        let pearlRespawn: PearlRespawnBounds[] = [];
        const portalsById = new Map<number, Edge[]>();
        const dragons: DragonData[] = [];
        const counts = { TILE: -1, EDGE: -1, DRAGON: -1 };
        const seen = { TILE: 0, EDGE: 0, DRAGON: 0 };

        const numbers = (fields: string[], from: number, what: string): number[] => {
            const values = fields.slice(from).map(Number);
            if (values.some((v) => !Number.isInteger(v)))
                throw new Error(`${what} needs whole numbers: ${fields.join(" ")}`);
            return values;
        };

        for (const rawLine of text.split("\n")) {
            const line = rawLine.replace(/\r$/, "").trim();
            if (!line || line.startsWith("#")) continue;
            if (line === "END") break;

            const fields = line.split(/\s+/);
            const keyword = RENAMED[fields[0]] ?? fields[0];

            if (keyword === "MAP") {
                [width, height] = numbers(fields, 1, "MAP");
                if (width <= 0 || height <= 0) throw new Error(`map must be at least 1x1, got ${width}x${height}`);
                tiles = new Uint8Array(width * height);
                hEdges = new Uint8Array((height + 1) * width);
                vEdges = new Uint8Array(height * (width + 1));
                pearlRespawn = Array.from({ length: width * height }, () => ({ minRounds: 0, maxRounds: 0 }));
                continue;
            }
            if (width === 0) throw new Error(`MAP must come before "${line}"`);

            switch (keyword) {
                case "ROUNDS":
                    // Older replays embed this retired map header. It no longer
                    // controls game length and is never written back out.
                    break;
                case "UNIT_LIMIT": {
                    const [limit] = numbers(fields, 1, "UNIT_LIMIT");
                    if (fields.length !== 2 || limit <= 0)
                        throw new Error(`UNIT_LIMIT needs one positive count: ${line}`);
                    unitLimit = limit;
                    break;
                }
                case "MAP_NAME":
                    mapName = line.slice(keyword.length).trim() || undefined;
                    break;
                case "SYMMETRY": {
                    const value = fields[1] as MapSymmetry;
                    if (fields.length !== 2 || !SYMMETRIES.includes(value)) {
                        throw new Error(`SYMMETRY must be one of ${SYMMETRIES.join(", ")}: ${line}`);
                    }
                    symmetry = value;
                    break;
                }
                case "TILE_COUNT":
                case "EDGE_COUNT":
                case "DRAGON_COUNT":
                    [counts[keyword.slice(0, -6) as keyof typeof counts]] = numbers(fields, 1, keyword);
                    break;
                case "TILE": {
                    const [x, y, minRounds, maxRounds] = numbers(fields, 1, "TILE");
                    if (!(x >= 0 && x < width && y >= 0 && y < height))
                        throw new Error(`TILE (${x},${y}) is out of bounds`);
                    pearlRespawn[y * width + x] = { minRounds, maxRounds };
                    seen.TILE++;
                    break;
                }
                case "EDGE": {
                    const [id, type, portalId] = numbers(fields, 1, "EDGE");
                    const slot = edgeIdToSlot(id, width, height);
                    const value = type === 1 ? EdgeTile.Kelp : type === 2 ? EdgeTile.Portal : EdgeTile.Empty;
                    if (slot.horizontal) hEdges[slot.index] = value;
                    else vEdges[slot.index] = value;
                    if (type === 2) {
                        if (portalId < 0) throw new Error(`EDGE ${id} is a portal without a portal id`);
                        const group = portalsById.get(portalId) ?? [];
                        group.push(slot.edge);
                        portalsById.set(portalId, group);
                    }
                    seen.EDGE++;
                    break;
                }
                case "DRAGON": {
                    const [team, segmentCount, ...coordinates] = numbers(fields, 1, "DRAGON");
                    if (coordinates.length !== 2 * segmentCount) {
                        throw new Error(`DRAGON declares ${segmentCount} segments but lists ${coordinates.length / 2}`);
                    }
                    const body: Vector[] = [];
                    for (let i = 0; i < coordinates.length; i += 2) {
                        body.push({ x: coordinates[i], y: coordinates[i + 1] });
                    }
                    dragons.push({
                        id: dragons.length,
                        team: team === 0 ? "A" : "B",
                        facing: dragonFacing(body, width, height),
                        body,
                    });
                    seen.DRAGON++;
                    break;
                }
                default:
                    throw new Error(`unrecognised map line "${line}"`);
            }
        }

        if (width === 0) throw new Error("map has no MAP line");
        for (const kind of ["TILE", "EDGE", "DRAGON"] as const) {
            if (counts[kind] !== seen[kind]) {
                throw new Error(`${kind}_COUNT says ${counts[kind]} but the file holds ${seen[kind]}`);
            }
        }

        const portals: [Edge, Edge][] = [];
        for (const portalId of [...portalsById.keys()].sort((a, b) => a - b)) {
            const group = portalsById.get(portalId)!;
            if (group.length !== 2) throw new Error(`portal ${portalId} joins ${group.length} edges, expected 2`);
            portals.push([group[0], group[1]]);
        }

        return new StaticMap(
            width,
            height,
            tiles,
            hEdges,
            vEdges,
            portals,
            dragons,
            pearlRespawn,
            unitLimit,
            symmetry,
            mapName,
        );
    }
}

/** How long a tile waits between pearl spawn attempts; 0..0 means never. */
export interface PearlRespawnBounds {
    minRounds: number;
    maxRounds: number;
}

interface EdgeSlot {
    horizontal: boolean;
    /** Index into `initialHEdges` or `initialVEdges`. */
    index: number;
    edge: Edge;
}

/**
 * Decompose a global edge id over the (width+1) x (2*height+1) boundary grid.
 * Even rows are the boundary above tile row y = row/2; odd rows are the
 * boundaries left of each tile in row y = (row-1)/2.
 */
export function edgeIdToSlot(id: number, width: number, height: number): EdgeSlot {
    const stride = width + 1;
    const row = Math.floor(id / stride);
    const column = id % stride;
    if (row < 0 || row > 2 * height) throw new Error(`edge id ${id} is outside the boundary grid`);

    if (row % 2 === 0) {
        if (column >= width) throw new Error(`edge id ${id} is a horizontal padding slot`);
        const y = row / 2;
        return { horizontal: true, index: y * width + column, edge: { x: column, y, side: "N" } };
    }
    const y = (row - 1) / 2;
    return { horizontal: false, index: y * stride + column, edge: { x: column, y, side: "W" } };
}

/** Global edge id of a tile boundary, canonicalised to its N/W anchor. */
export function edgeToId(edge: Edge, width: number): number {
    const key = edgeKey(edge);
    const [kind, coordinates] = key.split(":");
    const [a, b] = coordinates.split(",").map(Number);
    return kind === "H" ? 2 * b * (width + 1) + a : (2 * b + 1) * (width + 1) + a;
}

/** Which way the head points, from the step that leads into it. */
export function dragonFacing(body: Vector[], width: number, height: number): Direction {
    if (body.length < 2) return "E";
    const [head, neck] = body;
    const dx = (head.x - neck.x + width) % width;
    const dy = (head.y - neck.y + height) % height;
    if (dx === 1) return "E";
    if (dx === width - 1) return "W";
    if (dy === 1) return "S";
    if (dy === height - 1) return "N";
    return "E";
}

/** Render a map back to the engine's file format; inverse of `fromMapText`. */
export function serializeMapText(map: StaticMap, { canonicalEdgesOnly = false } = {}): string {
    const lines = [`MAP ${map.width} ${map.height}`];
    if (map.unitLimit !== undefined) lines.push(`UNIT_LIMIT ${map.unitLimit}`);
    if (map.symmetry) lines.push(`SYMMETRY ${map.symmetry}`);
    if (map.mapName) lines.push(`MAP_NAME ${map.mapName}`);

    lines.push(`TILE_COUNT ${map.width * map.height}`);
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const { minRounds, maxRounds } = map.pearlRespawn[y * map.width + x];
            lines.push(`TILE ${x} ${y} ${minRounds} ${maxRounds}`);
        }
    }

    // Usually one id per boundary. An inside end shared by the two copies of a
    // border portal is in both of their pairs, and is listed once for each.
    const portalIdsOf = new Map<string, number[]>();
    map.portals.forEach((pair, portalId) => {
        for (const edge of pair) {
            const key = edgeKey(edge);
            portalIdsOf.set(key, [...(portalIdsOf.get(key) ?? []), portalId]);
        }
    });

    // Ascending edge id, which interleaves the horizontal and vertical rows.
    const edgeLines: string[] = [];
    for (let row = 0; row <= 2 * map.height; row++) {
        if (canonicalEdgesOnly && row === 2 * map.height) break;
        const columns = row % 2 === 0 ? map.width : map.width + 1;
        for (let column = 0; column < columns; column++) {
            if (canonicalEdgesOnly && column === map.width) continue;
            const horizontal = row % 2 === 0;
            const edge: Edge = horizontal
                ? { x: column, y: row / 2, side: "N" }
                : { x: column, y: (row - 1) / 2, side: "W" };
            const stored = horizontal
                ? map.initialHEdges[edge.y * map.width + column]
                : map.initialVEdges[edge.y * (map.width + 1) + column];
            const id = row * (map.width + 1) + column;
            const portalIds = portalIdsOf.get(edgeKey(edge));
            if (portalIds) {
                for (const portalId of portalIds) edgeLines.push(`EDGE ${id} 2 ${portalId}`);
            } else {
                edgeLines.push(`EDGE ${id} ${stored === EdgeTile.Kelp ? 1 : 0} -1`);
            }
        }
    }
    lines.push(`EDGE_COUNT ${edgeLines.length}`, ...edgeLines);

    lines.push(`DRAGON_COUNT ${map.initialDragons.length}`);
    for (const dragon of map.initialDragons) {
        const coordinates = dragon.body.map((c) => `${c.x} ${c.y}`).join(" ");
        lines.push(`DRAGON ${dragon.team === "A" ? 0 : 1} ${dragon.body.length} ${coordinates}`);
    }

    lines.push("END");
    return lines.join("\n") + "\n";
}

/** Mutable board state for one round. */
export class CurrentMap {
    public readonly staticMap: StaticMap;
    /** Row-major cell contents, values from `Tile`. */
    public readonly tiles: Uint8Array;
    /** Horizontal boundaries, values from `EdgeTile`. */
    public readonly hEdges: Uint8Array;
    /** Vertical boundaries, values from `EdgeTile`. */
    public readonly vEdges: Uint8Array;

    constructor(from: StaticMap | CurrentMap) {
        if (from instanceof StaticMap) {
            this.staticMap = from;
            this.tiles = new Uint8Array(from.initialTiles);
            this.hEdges = new Uint8Array(from.initialHEdges);
            this.vEdges = new Uint8Array(from.initialVEdges);
        } else {
            this.staticMap = from.staticMap;
            this.tiles = new Uint8Array(from.tiles);
            this.hEdges = new Uint8Array(from.hEdges);
            this.vEdges = new Uint8Array(from.vEdges);
        }
    }

    get width(): number {
        return this.staticMap.width;
    }

    get height(): number {
        return this.staticMap.height;
    }

    get portals(): [Edge, Edge][] {
        return this.staticMap.portals;
    }

    get portalLabels(): number[] {
        return this.staticMap.portalLabels;
    }

    copy(): CurrentMap {
        return new CurrentMap(this);
    }

    inBounds(x: number, y: number): boolean {
        return this.staticMap.inBounds(x, y);
    }

    tileAt(x: number, y: number): Tile {
        return this.tiles[y * this.width + x] as Tile;
    }

    /** Edge array index for an anchored edge. */
    #edgeIndex(edge: Edge): { map: Uint8Array; index: number } {
        switch (edge.side) {
            case "N":
                return { map: this.hEdges, index: edge.y * this.width + edge.x };
            case "S":
                return { map: this.hEdges, index: (edge.y + 1) * this.width + edge.x };
            case "W":
                return { map: this.vEdges, index: edge.y * (this.width + 1) + edge.x };
            case "E":
                return { map: this.vEdges, index: edge.y * (this.width + 1) + edge.x + 1 };
        }
    }

    edgeAt(x: number, y: number, side: Direction): EdgeTile {
        // Match the engine's single stored copy of each torus boundary.
        const edge: Edge =
            side === "N" || side === "S"
                ? {
                      x: ((x % this.width) + this.width) % this.width,
                      y: (((y + (side === "S" ? 1 : 0)) % this.height) + this.height) % this.height,
                      side: "N",
                  }
                : {
                      x: (((x + (side === "E" ? 1 : 0)) % this.width) + this.width) % this.width,
                      y: ((y % this.height) + this.height) % this.height,
                      side: "W",
                  };
        const { map, index } = this.#edgeIndex(edge);
        return map[index] as EdgeTile;
    }

    setEdge(edge: Edge, tile: EdgeTile): void {
        const { map, index } = this.#edgeIndex(edge);
        map[index] = tile;
    }

    /** All wall edges, anchored N/W. Border edges anchor just out of bounds. */
    kelpEdges(): Edge[] {
        const walls: Edge[] = [];
        for (let by = 0; by <= this.height; by++) {
            for (let x = 0; x < this.width; x++) {
                if (this.hEdges[by * this.width + x] === EdgeTile.Kelp) {
                    walls.push({ x, y: by, side: "N" });
                }
            }
        }
        for (let y = 0; y < this.height; y++) {
            for (let bx = 0; bx <= this.width; bx++) {
                if (this.vEdges[y * (this.width + 1) + bx] === EdgeTile.Kelp) {
                    walls.push({ x: bx, y, side: "W" });
                }
            }
        }
        return walls;
    }

    /** Apply one map event. Dragon events are ignored (handled by `Bodies`). */
    applyEvent(event: GameEvent): void {
        if (event.type !== "tileChange") return;
        this.tiles[event.tile.y * this.width + event.tile.x] = event.hasPearl ? Tile.Pearl : Tile.Empty;
    }
}

/** Where one step from `from` leads: through kelp nowhere, through a portal to its far mouth, off the board around to the other side. */
export function stepFrom(map: CurrentMap, from: Vector, dir: Direction): Vector | undefined {
    const edge = map.edgeAt(from.x, from.y, dir);
    if (edge === EdgeTile.Kelp) return undefined;
    let destination = movePoint(from, dir);
    if (edge === EdgeTile.Portal) {
        const paired = map.staticMap.portalMap.get(
            wrappedEdgeKey({ x: from.x, y: from.y, side: dir }, map.width, map.height),
        );
        if (paired) destination = farSideOf(paired, dir);
    }
    return {
        x: ((destination.x % map.width) + map.width) % map.width,
        y: ((destination.y % map.height) + map.height) % map.height,
    };
}

/** The cell past a boundary when crossing it in `dir`; positive crossings exit positively. */
function farSideOf(edge: Edge, dir: Direction): Vector {
    const vertical = edge.side === "W" || edge.side === "E";
    if (vertical && (dir === "E" || dir === "W")) {
        const column = edge.side === "W" ? edge.x : edge.x + 1;
        return { x: dir === "E" ? column : column - 1, y: edge.y };
    }
    if (!vertical && (dir === "N" || dir === "S")) {
        const row = edge.side === "N" ? edge.y : edge.y + 1;
        return { x: edge.x, y: dir === "S" ? row : row - 1 };
    }
    return { x: edge.x, y: edge.y };
}

export interface PearlView {
    x: number;
    y: number;
    cx: number;
    cy: number;
    /** 0..1: grows when spawning, shrinks when eaten. */
    scale: number;
}
