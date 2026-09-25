// Skins: how the game looks. Board art and dragon art are independent and can be
// cross-combined. All coordinates are in device pixels, origin at the board's
// top-left.

import { classifyBody, type BodySegment, type DragonPart, type DragonTint, type DragonView } from "./Bodies";
import { Tile, type TeamId } from "./Schema";
import { isDuplicateTorusEdge, type PearlView, type CurrentMap, type Edge } from "./Map";
import type { BoardSize, Vector } from "./Vector";

/** Context passed to every skin hook. */
export interface SkinContext {
    /** Cell size in device pixels. */
    cell: number;
    /** Monotonic clock in ms, for ambient animation. */
    time: number;
    /** Portal pairs; pass to `classifyBody` for correct shapes around portals. */
    portals?: readonly (readonly [Edge, Edge])[];
    /** Board extent, so shapes resolve across the wrapped border too. */
    board?: BoardSize;
    /** Hide the duplicate bottom/right boundary when presenting a toroidal game board. */
    suppressTorusDuplicates?: boolean;
}

/** Board look. `drawBoard` is cached; `drawPearl` runs each frame. */
export interface MapSkin {
    ready?: Promise<unknown>;
    drawBoard(ctx: CanvasRenderingContext2D, map: CurrentMap, sc: SkinContext): void;
    drawPearl(ctx: CanvasRenderingContext2D, pearl: PearlView, sc: SkinContext): void;
    portalColor?(pairIndex: number): string;
}

/** Dragon look for one team. */
export interface TeamDragonSkin {
    ready?: Promise<unknown>;
    /**
     * The creature's own colour, for the places that stand for a team without
     * drawing it: swatches, the log's dots, the minimap. A team is known by
     * what it plays as, so this travels with the skin rather than with the A/B
     * slot the team happens to occupy.
     */
    color?: string;
    drawDragon(ctx: CanvasRenderingContext2D, dragon: DragonView, sc: SkinContext): void;
}

export interface PerTeamDragonSkins {
    teamA: TeamDragonSkin;
    teamB: TeamDragonSkin;
}

export type DragonSkin = TeamDragonSkin | PerTeamDragonSkins;

/** Resolve the skin to use for `team`. */
export function resolveDragonSkin(skin: DragonSkin, team: TeamId): TeamDragonSkin {
    if ("drawDragon" in skin) return skin;
    return team === "A" ? skin.teamA : skin.teamB;
}

export interface TeamStyle {
    body: string;
    head: string;
}

/** Palette overrides for built-in vector map skins. */
export interface MapSkinOptions {
    floor?: [string, string];
    /** Whole-cell wall fill. */
    wall?: string;
    /** Thin wall-edge colour. */
    wallEdge?: string;
    /** Single colour overriding per-pair portal colours. */
    portal?: string;
    pearl?: string;
}

/** Palette overrides for built-in vector dragon skins. */
export interface DragonSkinOptions {
    teams?: Record<TeamId, TeamStyle>;
}

const MAP_DEFAULTS: Required<MapSkinOptions> = {
    floor: ["#273a6a", "#354677"],
    wall: "#22331f",
    wallEdge: "#3d8b7a",
    portal: "",
    pearl: "#ff2d16",
};

const DRAGON_DEFAULTS: Required<DragonSkinOptions> = {
    teams: {
        A: { body: "#4d9996", head: "#4d9996" },
        B: { body: "#c96540", head: "#c96540" },
    },
};

// Hues only: the sprite skin keeps the ring's own lightness (see `tintedTile`),
// so these read at one brightness on the floor. Teal and orange are left out
// because they are the team colours. 
const PORTAL_COLORS = [
    "#00a2ff",
    "#ffd400",
    "#ff3df2",
    "#8fe000",
    "#9b6bff",
    "#ff2e6e",
    "#ffffff",
    "#33ff5c",
    "#335cff",
    "#ff5533",
    "#97ff7a",
    "#be33ff",
    "#ff7acc",
    "#7affba",
    "#f2ff7a",
    "#4133ff",
    "#ff7a83",
    "#7aabff",
    "#3aff33",
    "#ed7aff",
    "#88ff33",
    "#c17aff",
    "#7a7fff",
    "#ff7ae4",
    "#ff7ab4",
    "#65ec90",
    "#8e7aff",
    "#7adcff",
    "#d3ff33",
    "#8b33ff",
    "#7aff83",
    "#fff833",
];

/**
 * A colour per portal pair. Past the end of the palette the colours repeat;
 * hovering a portal marks both of its ends, which tells repeated pairs apart.
 */
export function portalPairColor(pairIndex: number, palette: readonly string[] = PORTAL_COLORS): string {
    return palette[pairIndex % palette.length];
}

/** The pair's id, drawn on its edges so a portal is identifiable up close. */
function portalLabel(ctx: CanvasRenderingContext2D, edge: Edge, cell: number, pairIndex: number, color: string): void {
    if (cell < 14) return;
    const size = Math.round(cell * 0.34);
    const [from, to] = edgeSegment(edge, cell);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    ctx.save();
    ctx.font = `${size}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, size * 0.28);
    ctx.strokeStyle = "rgba(6, 12, 22, 0.85)";
    ctx.strokeText(String(pairIndex), mid.x, mid.y);
    ctx.fillStyle = color;
    ctx.fillText(String(pairIndex), mid.x, mid.y);
    ctx.restore();
}

/** How far the sprite skin stretches the portal ring across its edge. */
const PORTAL_DEPTH = 1.5;

/** One device pixel in the context's current units. */
function devicePixel(ctx: CanvasRenderingContext2D): number {
    const m = ctx.getTransform();
    return 1 / (Math.hypot(m.a, m.b) || 1);
}

/** Overlap past the wipe cut so rotating end sprites don't leave gaps. */
const WIPE_OVERHANG = 0.12;

const portalColor = (options: MapSkinOptions, pairIndex: number): string =>
    options.portal || portalPairColor(pairIndex);

//  inting

/** Parse `#rgb`/`#rrggbb` into components; null otherwise. */
function parseHex(color: string): [number, number, number] | null {
    const hex = color.trim();
    if (hex[0] !== "#") return null;
    const body = hex.slice(1);
    const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
    if (full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) return null;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** Blend `color` towards `tint` by `tint.strength`. Both must be hex. */
export function tintColor(color: string, tint: DragonTint | undefined): string {
    if (!tint || tint.strength <= 0) return color;
    const from = parseHex(color);
    const to = parseHex(tint.color);
    if (!from || !to) return color;
    const k = Math.min(1, tint.strength);
    const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
    return `rgb(${mix(from[0], to[0])}, ${mix(from[1], to[1])}, ${mix(from[2], to[2])})`;
}

let tintLayer: HTMLCanvasElement | null = null;

/**
 * Run `draw`, then tint the result with `tint`.
 */
export function withTint(
    ctx: CanvasRenderingContext2D,
    tint: DragonTint | undefined,
    draw: (target: CanvasRenderingContext2D) => void,
): void {
    if (!tint || tint.strength <= 0) return draw(ctx);

    const { width, height } = ctx.canvas;
    if (!tintLayer) tintLayer = document.createElement("canvas");
    if (tintLayer.width !== width || tintLayer.height !== height) {
        tintLayer.width = width;
        tintLayer.height = height;
    }
    const layer = tintLayer.getContext("2d")!;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(0, 0, width, height);

    // Preserve the caller's transform so the skin lands in the right place.
    layer.setTransform(ctx.getTransform());
    draw(layer);

    // Wash in device space so the transform isn't applied twice.
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-atop";
    layer.globalAlpha = Math.min(1, tint.strength);
    layer.fillStyle = tint.color;
    layer.fillRect(0, 0, width, height);
    layer.globalCompositeOperation = "source-over";
    layer.globalAlpha = 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(tintLayer, 0, 0);
    ctx.restore();
}

// Shared drawing primitives

/**
 * Trace a polyline with rounded corners. `DragonView.segments` already arrive
 * rounded; use this only for polylines you build yourself.
 */
export function traceRounded(ctx: CanvasRenderingContext2D, pts: Vector[], radius: number): void {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
        ctx.arcTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, radius);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
}

/** Pixel-space endpoints of a cell edge; works for out-of-range anchors too. */
export function edgeSegment(edge: Edge, cell: number): [Vector, Vector] {
    const x = edge.x * cell;
    const y = edge.y * cell;
    switch (edge.side) {
        case "N":
            return [
                { x, y },
                { x: x + cell, y },
            ];
        case "S":
            return [
                { x, y: y + cell },
                { x: x + cell, y: y + cell },
            ];
        case "W":
            return [
                { x, y },
                { x, y: y + cell },
            ];
        case "E":
            return [
                { x: x + cell, y },
                { x: x + cell, y: y + cell },
            ];
    }
}

/** Solid bar for a wall/portal edge; ends extend half the thickness. */
export function edgeBar(ctx: CanvasRenderingContext2D, edge: Edge, cell: number, color: string): void {
    const [a, b] = edgeSegment(edge, cell);
    const thick = Math.max(2, cell * 0.14);
    ctx.fillStyle = color;
    ctx.fillRect(
        Math.min(a.x, b.x) - thick / 2,
        Math.min(a.y, b.y) - thick / 2,
        (a.y === b.y ? cell : 0) + thick,
        (a.x === b.x ? cell : 0) + thick,
    );
}

// Pixel: chunky retro squares

/** A chunky retro board: flat floor with a faint grid, walls and portals as
 * solid bars, square pearls. */
export function createPixelMapSkin(options: MapSkinOptions = {}): MapSkin {
    const o = { ...MAP_DEFAULTS, ...options };

    return {
        drawBoard(ctx, map, sc) {
            const { cell } = sc;

            // Flat floor with a faint 1px grid; the 0.5 offsets centre the
            // hairlines on physical pixels so they stay crisp.
            ctx.fillStyle = o.floor[0];
            ctx.fillRect(0, 0, map.width * cell, map.height * cell);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
            ctx.lineWidth = 1;
            for (let x = 0; x <= map.width; x++) {
                ctx.beginPath();
                ctx.moveTo(x * cell + 0.5, 0);
                ctx.lineTo(x * cell + 0.5, map.height * cell);
                ctx.stroke();
            }
            for (let y = 0; y <= map.height; y++) {
                ctx.beginPath();
                ctx.moveTo(0, y * cell + 0.5);
                ctx.lineTo(map.width * cell, y * cell + 0.5);
                ctx.stroke();
            }

            // Wall tiles (legacy maps).
            ctx.fillStyle = o.wall;
            for (let y = 0; y < map.height; y++) {
                for (let x = 0; x < map.width; x++) {
                    if (map.tiles[y * map.width + x] === Tile.Wall) {
                        ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
                    }
                }
            }

            // Wall edges and portals as solid bars.
            for (const wall of map.kelpEdges()) {
                if (sc.suppressTorusDuplicates && isDuplicateTorusEdge(wall, map)) continue;
                edgeBar(ctx, wall, cell, o.wallEdge);
            }
            map.portals.forEach((pair, i) => {
                const label = map.portalLabels[i] ?? i;
                const color = portalColor(options, label);
                for (const edge of pair) {
                    if (sc.suppressTorusDuplicates && isDuplicateTorusEdge(edge, map)) continue;
                    edgeBar(ctx, edge, cell, color);
                    portalLabel(ctx, edge, cell, label, color);
                }
            });
        },

        drawPearl(ctx, pearl, sc) {
            const { cell } = sc;
            const size = cell * 0.6 * pearl.scale;
            if (size <= 0) return;
            ctx.fillStyle = o.pearl;
            ctx.fillRect(pearl.cx - size / 2, pearl.cy - size / 2, size, size);
        },
    };
}

/**
 * A chunky retro dragon drawn cell-by-cell from what the dragon covers right
 * now. Doubles as the fallback while sprite sheets decode.
 */
export function createPixelDragonSkin(options: DragonSkinOptions = {}): TeamDragonSkin {
    const o = { teams: { ...DRAGON_DEFAULTS.teams, ...options.teams } };

    return {
        drawDragon(ctx, dragon, sc) {
            if (dragon.alpha <= 0) return;
            const { cell } = sc;
            const style = o.teams[dragon.team];
            const bodyColor = tintColor(style.body, dragon.tint);
            const headColor = tintColor(style.head, dragon.tint);
            const inset = Math.max(1, cell * 0.08);
            const cellOf = (p: Vector) => ({ x: Math.floor(p.x / cell), y: Math.floor(p.y / cell) });
            const headCell = cellOf(dragon.head);
            const tailCell = cellOf(dragon.tail);
            const same = (a: Vector, b: Vector) => a.x === b.x && a.y === b.y;
            ctx.save();
            ctx.globalAlpha = dragon.alpha;
            // Tail-to-head so the head square paints over its neighbour. A cell
            // is drawn while any body art or an end sits in it.
            for (let i = dragon.occupancy.length - 1; i >= 0; i--) {
                const { cell: c, from, to } = dragon.occupancy[i];
                if (dragon.dissolve !== undefined && dragon.dissolve - i >= 1) continue;
                const isHead = same(c, headCell);
                if (to - from <= 1e-6 && !isHead && !same(c, tailCell)) continue;
                ctx.fillStyle = isHead ? headColor : bodyColor;
                ctx.fillRect(c.x * cell + inset, c.y * cell + inset, cell - inset * 2, cell - inset * 2);
            }
            // Two square eye pixels on the head.
            const { headDir } = dragon;
            const perp = { x: -headDir.y, y: headDir.x };
            const hc = dragon.head;
            const es = Math.max(2, cell * 0.14);
            for (const side of [-1, 1]) {
                const ex = hc.x + headDir.x * cell * 0.12 + perp.x * cell * 0.18 * side;
                const ey = hc.y + headDir.y * cell * 0.12 + perp.y * cell * 0.18 * side;
                ctx.fillStyle = "#0a0e0a";
                ctx.fillRect(ex - es / 2, ey - es / 2, es, es);
            }
            ctx.restore();
        },
    };
}

export const pixelMapSkin: MapSkin = createPixelMapSkin();
export const pixelDragonSkin: TeamDragonSkin = createPixelDragonSkin();

// Sprite sheets

/** `[column, row]` of a tile in a sheet. */
export type SpriteRef = [number, number];

/** Sheet tile size: a number for square tiles, or `[width, height]`. */
export type TileSize = number | [number, number];

function tileWH(tile: TileSize): [number, number] {
    return Array.isArray(tile) ? tile : [tile, tile];
}

/**
 * Scroll a repeating texture along a straight segment. `speed` is texture
 * cycles per move; 1 (the default) keeps it in step with the body.
 */
export interface StraightScrollOptions {
    speed?: number;
}

/**
 * Bend a texture strip around a pivot for turn tiles. Distances are in UV units
 * (fractions of the tile). Defaults assume the base `turn` tile connects
 * north+east flowing east→north, matching `classifyBody`.
 */
export interface CornerWarpOptions {
    /** UV pivot; default `[1, 0]` (the tile's north-east corner). */
    pivot?: [number, number];
    /** Inside radius; default 0. Keep `innerRadius + stripWidth/2 = 0.5`. */
    innerRadius?: number;
    /** Strip thickness; default 1. */
    stripWidth?: number;
    /** Start angle in degrees; default 90. */
    angleOffsetDeg?: number;
    /** Total bend angle in degrees; default 90. */
    turnAngleDeg?: number;
    /** Cycles per move; default 1. */
    speed?: number;
    /** Angular slices; default 128. */
    slices?: number;
    /** Pixels per UV unit; default 512. */
    resolution?: number;
}

interface CornerWedge {
    canvas: HTMLCanvasElement;
    half: number;
    resolution: number;
}

/** Shared sprite-sheet loader for map and dragon sprite skins. */
function spriteSheet(src: string | HTMLImageElement | HTMLCanvasElement, tile: TileSize, smoothing?: boolean) {
    const [tw, th] = tileWH(tile);
    let image: HTMLImageElement | HTMLCanvasElement;
    let loaded = false;

    if (typeof src === "string") {
        image = new Image();
        image.src = src;
    } else {
        image = src;
        loaded = src instanceof HTMLCanvasElement || (src.complete && src.naturalWidth > 0);
    }
    const ready =
        image instanceof HTMLImageElement && !loaded
            ? image.decode().then(() => {
                  loaded = true;
              })
            : Promise.resolve();
    // Failed loads keep the fallback skin; don't crash the viewer.
    ready.catch(() => {});

    // Tinted tile copies: multiply by colour, restore alpha. Cached per (tile, colour).
    const tintCache = new Map<string, HTMLCanvasElement>();
    const tintedTile = (at: [number, number], color: string): HTMLCanvasElement => {
        const key = `${at[0]},${at[1]}|${color}`;
        let tile = tintCache.get(key);
        if (!tile) {
            tile = document.createElement("canvas");
            tile.width = tw;
            tile.height = th;
            const tctx = tile.getContext("2d")!;
            tctx.drawImage(image, at[0] * tw, at[1] * th, tw, th, 0, 0, tw, th);
            // "color" takes the hue from `color` and the lightness from the
            // sprite, so every pair is as bright as the art and dark hues
            // can't sink into the floor the way a multiply did.
            tctx.globalCompositeOperation = "color";
            tctx.fillStyle = color;
            tctx.fillRect(0, 0, tw, th);
            tctx.globalCompositeOperation = "destination-in";
            tctx.drawImage(image, at[0] * tw, at[1] * th, tw, th, 0, 0, tw, th);
            tintCache.set(key, tile);
        }
        return tile;
    };

    // Isolated tile crops: animated draws need a standalone image, and plain
    // blits need one to avoid filter smear from neighbouring sheet tiles.
    const MAX_ANIM_TILE_PX = 1024;
    const plainCache = new Map<string, HTMLCanvasElement>();
    const plainTile = (at: SpriteRef): HTMLCanvasElement => {
        const key = `${at[0]},${at[1]}`;
        let tile = plainCache.get(key);
        if (!tile) {
            const s = Math.min(1, MAX_ANIM_TILE_PX / Math.max(tw, th));
            const w = Math.max(1, Math.round(tw * s));
            const h = Math.max(1, Math.round(th * s));
            tile = document.createElement("canvas");
            tile.width = w;
            tile.height = h;
            const tctx = tile.getContext("2d")!;
            tctx.imageSmoothingEnabled = true;
            tctx.drawImage(image, at[0] * tw, at[1] * th, tw, th, 0, 0, w, h);
            plainCache.set(key, tile);
        }
        return tile;
    };

    // Repeating patterns for scrolling draws, one per tile. Patterns aren't bound
    // to the context that made them, and the transform is set per fill.
    const patternCache = new Map<string, CanvasPattern>();
    const tilePattern = (ctx: CanvasRenderingContext2D, at: SpriteRef): CanvasPattern | null => {
        const key = `${at[0]},${at[1]}`;
        let pattern = patternCache.get(key);
        if (!pattern) {
            const made = ctx.createPattern(plainTile(at), "repeat");
            if (!made) return null;
            pattern = made;
            patternCache.set(key, pattern);
        }
        return pattern;
    };

    // Re-orient the strip for the corner wedge: the warp treats x as radial and
    // y as flow, but body art flows along +x. `mirrored` handles left bends.
    const flowCache = new Map<string, HTMLCanvasElement>();
    const flowTile = (at: SpriteRef, mirrored: boolean): HTMLCanvasElement => {
        const key = `${at[0]},${at[1]}|${mirrored}`;
        let out = flowCache.get(key);
        if (!out) {
            const src = plainTile(at);
            out = document.createElement("canvas");
            out.width = src.height;
            out.height = src.width;
            const octx = out.getContext("2d")!;
            octx.imageSmoothingEnabled = true;
            if (mirrored) octx.setTransform(0, 1, 1, 0, 0, 0);
            else octx.setTransform(0, 1, -1, 0, src.height, 0);
            octx.drawImage(src, 0, 0);
            flowCache.set(key, out);
        }
        return out;
    };

    // Rasterize one period of the corner warp and cache it. Only the angular
    // phase changes per frame, so the wedge shape can be reused.
    const wedgeCache = new Map<string, CornerWedge>();
    const cornerWedge = (at: SpriteRef, o: Required<CornerWarpOptions>, reverse: boolean): CornerWedge => {
        const key = [
            at[0],
            at[1],
            o.pivot[0],
            o.pivot[1],
            o.innerRadius,
            o.stripWidth,
            o.angleOffsetDeg,
            o.turnAngleDeg,
            o.slices,
            o.resolution,
            reverse,
        ].join("|");
        let wedge = wedgeCache.get(key);
        if (wedge) return wedge;

        const tileSrc = flowTile(at, reverse);
        const R = o.resolution;
        const angleOffset = (o.angleOffsetDeg * Math.PI) / 180;
        const turnAngle = (o.turnAngleDeg * Math.PI) / 180;
        const innerR = o.innerRadius * R;
        const outerR = (o.innerRadius + o.stripWidth) * R;
        const half = Math.ceil(outerR) + 2;

        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = half * 2;
        const wctx = canvas.getContext("2d")!;
        wctx.imageSmoothingEnabled = true;

        // Wrap the strip around the pivot as thin rotated bands. `reverse`
        // samples back-to-front for left bends.
        const slices = Math.max(4, o.slices);
        const sliceAngle = turnAngle / slices;
        const destW = Math.max(1, outerR - innerR);
        const destH = Math.max(1, outerR * sliceAngle * 2.2);
        const bandH = tileSrc.height / slices;
        for (let i = 0; i < slices; i++) {
            const bandIndex = reverse ? slices - 1 - i : i;
            wctx.save();
            wctx.translate(half, half);
            wctx.rotate(angleOffset + i * sliceAngle);
            wctx.drawImage(tileSrc, 0, bandIndex * bandH, tileSrc.width, bandH, innerR, -destH / 2, destW, destH);
            wctx.restore();
        }

        wedge = { canvas, half, resolution: R };
        wedgeCache.set(key, wedge);
        return wedge;
    };

    return {
        ready,
        get loaded() {
            return loaded;
        },
        /** Draw a sprite centred at (cx, cy), scaled to `cell * scale` and
         * rotated by `rot`. Returns false when `at` is missing. */
        blit(
            ctx: CanvasRenderingContext2D,
            at: SpriteRef | undefined,
            cx: number,
            cy: number,
            cell: number,
            rot = 0,
            scale = 1,
        ): boolean {
            if (!at) return false;
            ctx.save();
            ctx.imageSmoothingEnabled = smoothing ?? false;
            ctx.translate(cx, cy);
            if (rot) ctx.rotate(rot);
            // Draw from the isolated tile canvas to avoid filter smear from
            // neighbouring sheet tiles.
            const size = cell * scale;
            ctx.drawImage(plainTile(at), -size / 2, -size / 2, size, size);
            ctx.restore();
            return true;
        },
        /** Like `blit`, but tinted first (hue from `color`, lightness and alpha from the sprite). */
        blitTinted(
            ctx: CanvasRenderingContext2D,
            at: SpriteRef | undefined,
            color: string,
            cx: number,
            cy: number,
            cell: number,
            rot = 0,
            scale = 1,
        ): boolean {
            if (!at) return false;
            const tile = tintedTile(at, color);
            ctx.save();
            ctx.imageSmoothingEnabled = smoothing ?? false;
            ctx.translate(cx, cy);
            if (rot) ctx.rotate(rot);
            const size = cell * scale;
            ctx.drawImage(tile, -size / 2, -size / 2, size, size);
            ctx.restore();
            return true;
        },
        /**
         * Like `blit`, but scrolls the tile as a repeating texture. `moveT` is
         * the segment's move progress this round (use 1 at rest). A positive
         * `speed` carries the texture toward local +x, the tail→head direction.
         */
        blitScrolling(
            ctx: CanvasRenderingContext2D,
            at: SpriteRef | undefined,
            cx: number,
            cy: number,
            cell: number,
            rot = 0,
            scale = 1,
            moveT = 1,
            opts: StraightScrollOptions = {},
        ): boolean {
            if (!at) return false;
            const src = plainTile(at);
            const pattern = tilePattern(ctx, at);
            if (!pattern) return false;
            const size = cell * scale;
            const offset = moveT * (opts.speed ?? 1) * size;
            pattern.setTransform(
                new DOMMatrix([size / src.width, 0, 0, size / src.height, offset - size / 2, -size / 2]),
            );

            ctx.save();
            ctx.imageSmoothingEnabled = smoothing ?? false;
            ctx.translate(cx, cy);
            if (rot) ctx.rotate(rot);
            ctx.fillStyle = pattern;
            // One screen pixel longer at each end, along the body: neighbouring
            // tiles meet on a fractional pixel, and two half-covered edges let
            // the floor through as a seam. The texture repeats, so the overlap
            // is the same art the neighbour draws there.
            const px = devicePixel(ctx);
            ctx.fillRect(-size / 2 - px, -size / 2, size + px * 2, size);
            ctx.restore();
            return true;
        },
        /**
         * Warp the tile around a pivot for a turn tile. `moveT` is the segment's
         * move progress (1 at rest). The wedge is rasterized once per
         * (tile, options) and then just rotated; two copies cover the fixed
         * viewing window. `reverse` is for left-bend corners.
         */
        blitCornerWarp(
            ctx: CanvasRenderingContext2D,
            at: SpriteRef | undefined,
            cx: number,
            cy: number,
            cell: number,
            rot = 0,
            scale = 1,
            moveT = 1,
            opts: CornerWarpOptions = {},
            reverse = false,
        ): boolean {
            if (!at) return false;
            const o: Required<CornerWarpOptions> = {
                // Defaults match `classifyBody`'s base turn (north+east, flow
                // east→north) and send the whole tile through the bend so the
                // strip centreline lands on the tile edge midpoints.
                pivot: opts.pivot ?? [1, 0],
                innerRadius: opts.innerRadius ?? 0,
                stripWidth: opts.stripWidth ?? 1,
                angleOffsetDeg: opts.angleOffsetDeg ?? 90,
                turnAngleDeg: opts.turnAngleDeg ?? 90,
                speed: opts.speed ?? 1,
                slices: opts.slices ?? 128,
                resolution: opts.resolution ?? 512,
            };
            const wedge = cornerWedge(at, o, reverse);
            const size = cell * scale;
            const scaleFactor = size / wedge.resolution;
            const angleOffset = (o.angleOffsetDeg * Math.PI) / 180;
            const turnAngle = (o.turnAngleDeg * Math.PI) / 180;
            const pivot = { x: o.pivot[0] * size - size / 2, y: o.pivot[1] * size - size / 2 };
            const innerRpx = o.innerRadius * size;
            const outerRpx = (o.innerRadius + o.stripWidth) * size;

            const phase = (((moveT * o.speed) % 1) + 1) % 1;
            // Right bends flow tail→head with increasing angle; reverse flips
            // that for left bends so both scroll consistently.
            const dir = reverse ? -1 : 1;
            const delta = dir * phase * turnAngle;
            const destHalf = wedge.half * scaleFactor;

            ctx.save();
            ctx.imageSmoothingEnabled = smoothing ?? false;
            ctx.translate(cx, cy);
            if (rot) ctx.rotate(rot);

            // Widened by about a screen pixel at each end, to overlap the
            // straights either side (see `blitScrolling`).
            const overlap = (devicePixel(ctx) * 2) / Math.max(1, outerRpx);
            ctx.beginPath();
            ctx.arc(pivot.x, pivot.y, outerRpx, angleOffset - overlap, angleOffset + turnAngle + overlap);
            ctx.arc(pivot.x, pivot.y, innerRpx, angleOffset + turnAngle + overlap, angleOffset - overlap, true);
            ctx.closePath();
            ctx.clip();

            for (const d of [delta, delta - dir * turnAngle]) {
                ctx.save();
                ctx.translate(pivot.x, pivot.y);
                ctx.rotate(d);
                ctx.drawImage(wedge.canvas, -destHalf, -destHalf, destHalf * 2, destHalf * 2);
                ctx.restore();
            }

            ctx.restore();
            return true;
        },
    };
}

/**
 * Sheet slots a board skin can fill.
 *
 * `wall` fills a whole blocked cell (`#` in a .map file); `wall-edge` sits on
 * the boundary *between* two cells (`-`/`|`), which is what current maps are
 * built from. `portal-accent` is the tintable overlay layer.
 */
export type SpriteMapPart = "floor" | "floor-alt" | "wall" | "wall-edge" | "pearl" | "portal" | "portal-accent";

export interface SpriteMapSkinOptions {
    /** Image URL, an already-loaded image element, or a canvas (for
     * programmatically generated sheets). */
    src: string | HTMLImageElement | HTMLCanvasElement;
    /** Size of one tile in the sheet, in source pixels: a single number for
     * square tiles, or `[width, height]` for non-square ones. */
    tile: TileSize;
    /**
     * `[column, row]` of each part's tile. `wall-edge`/`portal` are centred on
     * the boundary between cells, so draw the barrier across the tile's middle.
     * Missing parts fall back to flat colours and bars; `wall`/`pearl` are
     * skipped. `portal-accent` overlays `portal` tinted per pair.
     */
    sprites: Partial<Record<SpriteMapPart, SpriteRef>>;
    /**
     * Accent colours cycled per portal pair (both edges of a pair share
     * one), used to tint `portal-accent` and for the bar fallback when the
     * sheet has no portal sprite. Defaults to the built-in palette.
     */
    portalColors?: string[];
    /** Bar colour for wall edges when the sheet has no `wall-edge` sprite. */
    wallEdgeColor?: string;
    /** Defaults to false, which keeps pixel art crisp. */
    smoothing?: boolean;
}

/**
 * Build a board skin from a sprite sheet. Falls back to the pixel map skin
 * until the image decodes (await `skin.ready` to avoid the flash), and stays
 * on it if the image fails to load.
 */
export function createSpriteMapSkin(options: SpriteMapSkinOptions): MapSkin {
    const fallback = createPixelMapSkin();
    const sheet = spriteSheet(options.src, options.tile, options.smoothing);
    const s = options.sprites;
    const portalColors = options.portalColors ?? PORTAL_COLORS;
    const wallEdgeColor = options.wallEdgeColor ?? MAP_DEFAULTS.wallEdge;

    return {
        ready: sheet.ready,

        drawBoard(ctx, map, sc) {
            if (!sheet.loaded) return fallback.drawBoard(ctx, map, sc);
            const { cell } = sc;

            // Backing colour shows through if the sheet has no floor sprites.
            ctx.fillStyle = MAP_DEFAULTS.floor[0];
            ctx.fillRect(0, 0, map.width * cell, map.height * cell);
            for (let y = 0; y < map.height; y++) {
                for (let x = 0; x < map.width; x++) {
                    const cx = (x + 0.5) * cell;
                    const cy = (y + 0.5) * cell;
                    // Checker between floor and floor-alt; fall back to plain
                    // floor when the sheet only provides one.
                    const floor = (x + y) % 2 === 0 ? s.floor : (s["floor-alt"] ?? s.floor);
                    sheet.blit(ctx, floor, cx, cy, cell);
                    if (map.tiles[y * map.width + x] === Tile.Wall) {
                        sheet.blit(ctx, s.wall, cx, cy, cell);
                    }
                }
            }

            // Thin wall edges: the sheet's `wall-edge` sprite centred on the
            // boundary (rotated for vertical ones), or a plain bar when the
            // sheet doesn't provide one.
            for (const edge of map.kelpEdges()) {
                if (sc.suppressTorusDuplicates && isDuplicateTorusEdge(edge, map)) continue;
                const [a, b] = edgeSegment(edge, cell);
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const rot = a.x === b.x ? Math.PI / 2 : 0;
                if (!sheet.blit(ctx, s["wall-edge"], mid.x, mid.y, cell, rot)) {
                    edgeBar(ctx, edge, cell, wallEdgeColor);
                }
            }
            map.portals.forEach((pair, i) => {
                const accent = portalPairColor(map.portalLabels[i] ?? i, portalColors);
                for (const edge of pair) {
                    if (sc.suppressTorusDuplicates && isDuplicateTorusEdge(edge, map)) continue;
                    // Prefer the sheet's portal sprite, centred on the edge,
                    // with the accent layer tinted per pair on top.
                    const [a, b] = edgeSegment(edge, cell);
                    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                    const rot = a.x === b.x ? Math.PI / 2 : 0;
                    if (sheet.blit(ctx, s.portal, mid.x, mid.y, cell, rot)) {
                        // Stretched across the edge so the ring spills into
                        // both cells; at its drawn depth it was a sliver.
                        ctx.save();
                        ctx.translate(mid.x, mid.y);
                        ctx.rotate(rot);
                        ctx.scale(1, PORTAL_DEPTH);
                        sheet.blitTinted(ctx, s["portal-accent"], accent, 0, 0, cell);
                        ctx.restore();
                    } else {
                        edgeBar(ctx, edge, cell, accent);
                    }
                }
            });
        },

        drawPearl(ctx, pearl, sc) {
            if (!sheet.loaded) return fallback.drawPearl(ctx, pearl, sc);
            if (pearl.scale <= 0) return;
            sheet.blit(ctx, s.pearl, pearl.cx, pearl.cy, sc.cell, 0, pearl.scale);
        },

        portalColor: (pairIndex) => portalPairColor(pairIndex, portalColors),
    };
}

/** The sheet slots a dragon skin can fill: the four body parts plus the
 * optional mirrored corner for front/back asymmetric art. */
export type DragonSpritePart = DragonPart | "turn-left";

export interface SpriteDragonSkinOptions {
    /** Image URL, an already-loaded image element, or a canvas (for
     * programmatically generated sheets). */
    src: string | HTMLImageElement | HTMLCanvasElement;
    /** Size of one tile in the sheet, in source pixels: a single number for
     * square tiles, or `[width, height]` for non-square ones. */
    tile: TileSize;
    /**
     * The `[column, row]` of each part's tile. Base orientations: head faces
     * east, body runs west→east flowing tail→head, `turn` connects
     * north+east flowing east→north (a right bend), tail's body continues
     * east. Per-cell rotation is applied automatically (see `classifyBody`).
     *
     * `turn-left` is the same corner flowing north→east; supply it for
     * direction-asymmetric art, otherwise `turn` serves both bends.
     */
    sprites: Partial<Record<DragonSpritePart, SpriteRef>>;
    /** Per-team overrides (e.g. differently coloured heads). */
    teamSprites?: Partial<Record<TeamId, Partial<Record<DragonSpritePart, SpriteRef>>>>;
    /** The creature's colour, for swatches and the minimap. */
    color?: string;
    /** Defaults to false, which keeps pixel art crisp. */
    smoothing?: boolean;
    /**
     * Procedural movement animation per part: scroll a repeating texture along
     * straight segments (`scroll`) and/or bend it around the pivot of turn
     * segments (`cornerWarp`) instead of blitting statically.
     *
     * Ends always glide; this only animates the texture between them.
     */
    animate?: {
        scroll?: Partial<Record<DragonPart, StraightScrollOptions>>;
        cornerWarp?: Partial<Record<DragonPart, CornerWarpOptions>>;
    };
}

/**
 * Build a dragon skin from a sprite sheet. Falls back to the pixel dragon skin
 * until the image decodes, and stays on it if the image fails to load.
 *
 * Body tiles stay on the grid and are wiped to what the dragon covers; the
 * head and tail sprites glide between cells. `animate` additionally flows
 * the texture through the body.
 */
export function createSpriteDragonSkin(options: SpriteDragonSkinOptions): TeamDragonSkin {
    const fallback = createPixelDragonSkin();
    const sheet = spriteSheet(options.src, options.tile, options.smoothing);

    const spriteFor = (part: DragonSpritePart, team: TeamId): SpriteRef | undefined =>
        options.teamSprites?.[team]?.[part] ?? options.sprites[part];

    /**
     * Draw one classified cell, dispatching to whatever `animate` configures for
     * that part (or a plain blit).
     */
    const drawPart = (
        ctx: CanvasRenderingContext2D,
        part: BodySegment,
        c: Vector,
        cell: number,
        scale: number,
        t: number,
        team: TeamId,
    ): void => {
        const { kind, rot, turnDir } = part;
        const cornerOpts = options.animate?.cornerWarp?.[kind];
        const scrollOpts = options.animate?.scroll?.[kind];
        const cx = (c.x + 0.5) * cell;
        const cy = (c.y + 0.5) * cell;

        if (cornerOpts) {
            sheet.blitCornerWarp(
                ctx,
                spriteFor(kind, team),
                cx,
                cy,
                cell,
                rot,
                scale,
                t,
                cornerOpts,
                turnDir === "left",
            );
            return;
        }
        const ref =
            kind === "turn" && turnDir === "left"
                ? (spriteFor("turn-left", team) ?? spriteFor("turn", team))
                : spriteFor(kind, team);
        if (scrollOpts) sheet.blitScrolling(ctx, ref, cx, cy, cell, rot, scale, t, scrollOpts);
        else sheet.blit(ctx, ref, cx, cy, cell, rot, scale);
    };

    const cornerGeom = (() => {
        const o = options.animate?.cornerWarp?.turn;
        return {
            pivot: o?.pivot ?? ([1, 0] as [number, number]),
            angleOffset: ((o?.angleOffsetDeg ?? 90) * Math.PI) / 180,
            turnAngle: ((o?.turnAngleDeg ?? 90) * Math.PI) / 180,
        };
    })();

    /**
     * The part of one cell a wipe keeps, as a clip path. `from`/`to` are
     * fractions along the body through it, 0 tail-side to 1 head-side.
     *
     * Straights cut square across the run and turns cut along a radius of the
     * corner warp's pivot
     */
    const wipePath = (
        part: BodySegment,
        c: Vector,
        cell: number,
        scale: number,
        from: number,
        to: number,
    ): Path2D | null => {
        if (to - from <= 1e-6) return null;
        const { kind, rot, turnDir } = part;
        const size = cell * scale;
        const cx = (c.x + 0.5) * cell;
        const cy = (c.y + 0.5) * cell;
        const cosr = Math.cos(rot);
        const sinr = Math.sin(rot);
        const toWorld = (lx: number, ly: number): [number, number] => [
            cx + lx * cosr - ly * sinr,
            cy + lx * sinr + ly * cosr,
        ];
        const path = new Path2D();

        if (kind === "turn") {
            const { pivot, angleOffset, turnAngle } = cornerGeom;
            // `turn` runs tail -> head with increasing angle; `turn-left` is that
            // mirrored, so its head is at the start of the sweep instead.
            const right = turnDir !== "left";
            const a0 = right ? angleOffset : angleOffset + turnAngle;
            const a1 = right ? angleOffset + turnAngle : angleOffset;
            const [px, py] = toWorld(pivot[0] * size - size / 2, pivot[1] * size - size / 2);
            const start = a0 + (a1 - a0) * from + rot;
            const end = a0 + (a1 - a0) * to + rot;
            // Radius past the cell's far corner, so the sector covers whatever
            // of the tile falls inside its angular range.
            path.moveTo(px, py);
            path.arc(px, py, size * 2, start, end, end < start);
            path.closePath();
            return path;
        }

        // Straight run: local +x points head-ward for `body`, and for the
        // `head`/`tail` cells that take the no-cap fallback.
        const x0 = -size / 2 + from * size;
        const x1 = -size / 2 + to * size;
        const y0 = -size / 2;
        const y1 = size / 2;
        path.moveTo(...toWorld(x0, y0));
        path.lineTo(...toWorld(x1, y0));
        path.lineTo(...toWorld(x1, y1));
        path.lineTo(...toWorld(x0, y1));
        path.closePath();
        return path;
    };

    return {
        ready: sheet.ready,
        color: options.color,

        /**
         * Every cell the dragon covers is drawn from its settled tile art, wiped
         * to the fraction the body actually covers right now, and the head and
         * tail sprites ride their interpolated poses on top. A dissolving
         * dragon is eaten from the head: each cell is wiped away in turn and the
         * caps go with their cells.
         */
        drawDragon(ctx, dragon, sc) {
            if (!sheet.loaded) return fallback.drawDragon(ctx, dragon, sc);
            const dissolving = dragon.dissolve !== undefined;
            // A dissolving dragon stays opaque: the sweep is the death animation, so
            // fading it as well would only wash it out.
            if (!dissolving && dragon.alpha <= 0) return;
            const { cell } = sc;
            const cells = dragon.occupancy.map((o) => o.cell);
            const parts = classifyBody(cells, dragon.facing, sc.portals, sc.board);
            const last = parts.length - 1;

            // Sheet colours can't be blended, so a tint is composited over the
            // finished dragon instead.
            withTint(ctx, dragon.tint, (target) => {
                target.save();
                target.globalAlpha = dissolving ? 1 : dragon.alpha;

                for (let i = last; i >= 0; i--) {
                    const eaten = dissolving ? dragon.dissolve! - i : 0;
                    if (eaten >= 1) continue;
                    const cover = dragon.occupancy[i];
                    const from = cover.from;
                    const to = Math.min(cover.to, 1 - Math.max(0, eaten));
                    if (to - from <= 1e-6) continue;

                    // An end cell with body art in it is mid-move, not a settled
                    // head or tail, so it takes the body's tile.
                    const classified = parts[i];
                    const part =
                        classified.kind === "head" || classified.kind === "tail"
                            ? { ...classified, kind: "body" as const }
                            : classified;

                    let clip: Path2D | null = null;
                    if (from > 0 || to < 1) {
                        // Overhang: run the body a little past the cut, under the sprite.
                        clip = wipePath(
                            part,
                            cells[i],
                            cell,
                            dragon.scale,
                            from > 0 ? Math.max(0, from - WIPE_OVERHANG) : from,
                            to < 1 ? Math.min(1, to + WIPE_OVERHANG) : to,
                        );
                        if (!clip) continue;
                        target.save();
                        target.clip(clip);
                    }
                    drawPart(target, part, cells[i], cell, dragon.scale, dragon.moveT, dragon.team);
                    if (clip) target.restore();
                }

                // Caps last, over the body; their poses are already interpolated.
                if (last > 0 && !(dissolving && dragon.dissolve! - last >= 1)) {
                    sheet.blit(
                        target,
                        spriteFor("tail", dragon.team),
                        dragon.tail.x,
                        dragon.tail.y,
                        cell,
                        Math.atan2(dragon.tailDir.y, dragon.tailDir.x),
                        dragon.scale,
                    );
                }
                if (!(dissolving && dragon.dissolve! >= 1)) {
                    sheet.blit(
                        target,
                        spriteFor("head", dragon.team),
                        dragon.head.x,
                        dragon.head.y,
                        cell,
                        Math.atan2(dragon.headDir.y, dragon.headDir.x),
                        dragon.scale,
                    );
                }
                target.restore();
            });
        },
    };
}
