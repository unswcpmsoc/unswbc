// Canvas renderer. Each instance owns a canvas and an offscreen cached board
// layer. `fit()` and `draw()` are cheap enough to call every frame.

import { defaultMapSkin, defaultDragonSkin } from "../skins/defaults";
import type { DragonView } from "./Bodies";
import type { CurrentMap, Edge } from "./Map";
import type { TimelineFrame } from "./Match";
import { DebugShape, type TeamId } from "./Schema";
import { resolveDragonSkin, type MapSkin, type SkinContext, type DragonSkin } from "./Skins";
import RoundTimeline, { type Ping } from "./Timeline";
import { DIRECTION_DELTA, type Vector } from "./Vector";
import type { Entity } from "./Entities";
import { edgeSegment } from "./Skins";
import bubbleSheet from "../assets/sonar/bubbles.png";

export type { DebugDraw } from "./Timeline";

/**
 * What a frame shows on top of the board. Salience is derived, not stored:
 * the hovered entity when there is one, otherwise every pinned entity.
 */
export interface Overlay {
    /** Entities drawn salient, with their annotations. */
    salient?: readonly Entity[];
    /** Knock everything that is not salient back. Only ever set by a hover. */
    dim?: boolean;
    /** Dragon selections allowed to show bot drawings. Defaults to salient dragons for API compatibility. */
    debugDragonIds?: readonly number[];
    /** Render status indicators for every visible dragon. Debug drawings remain selection-scoped. */
    showAllIndicators?: boolean;
    /** Only this team's bot output (drawings and indicators); both when unset. */
    outputTeam?: TeamId;
    /** The page's panel colours and font, so labels on the board match its tooltips. */
    theme?: BoardTheme;
    /** Pings to hold still on a paused board: those of the step just finished. */
    settledPings?: readonly Ping[];
}

export interface BoardTheme {
    panel: string;
    ink: string;
    rule: string;
    font: string;
}

const DEFAULT_THEME: BoardTheme = { panel: "#15181d", ink: "#eceef1", rule: "#262b33", font: "sans-serif" };

/**
 * A point `d` cells along a ping's path, placed within whichever cell it is
 * nearer so the wave jumps with the path through a portal or the wrap.
 */
function alongPath(path: readonly Vector[], reach: number, heading: Vector, cell: number) {
    return (d: number): Vector => {
        const k = Math.min(reach - 1, Math.floor(d));
        const f = d - k;
        const anchor = f < 0.5 ? path[k] : path[k + 1];
        const offset = f < 0.5 ? f : f - 1;
        return {
            x: (anchor.x + 0.5 + heading.x * offset) * cell,
            y: (anchor.y + 0.5 + heading.y * offset) * cell,
        };
    };
}

/**
 * The sonar bubbles, cut straight out of the tile the art came on: every shape
 * the artist drew except a motion smear and a three-pixel speck — clusters,
 * pairs and singles — each centred in its own square at the size it was drawn,
 * so one scale factor reproduces the art's own size mix.
 */
const BUBBLE_TILE = 48;
const BUBBLE_SPRITES = 11;

let sheet: HTMLImageElement | undefined;

/** The bubble sheet once it has decoded; nothing draws until then. */
function bubbleArt(): HTMLImageElement | undefined {
    if (typeof Image === "undefined") return undefined;
    if (!sheet) {
        sheet = new Image();
        sheet.src = bubbleSheet;
    }
    return sheet.complete && sheet.naturalWidth > 0 ? sheet : undefined;
}

/**
 * One bubble from the sheet. The art carries its own light from the top left,
 * the way the pearl on the board does, so bubbles are never turned to face the
 * heading — only the plume's shape says which way the ping went.
 */
function drawBubble(
    ctx: CanvasRenderingContext2D,
    art: HTMLImageElement,
    at: Vector,
    side: number,
    alpha: number,
    which: number,
): void {
    if (side <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(art, which * BUBBLE_TILE, 0, BUBBLE_TILE, BUBBLE_TILE, at.x - side / 2, at.y - side / 2, side, side);
    ctx.globalAlpha = 1;
}

/**
 * A stable roll in [0, 1) for bubble `i` of dragon `id`. The plume has to look
 * the same every time a frame is drawn, so which bubble is used and how it
 * wanders are hashed rather than random — a paused board and a playing one
 * then agree.
 */
function roll(id: number, i: number, salt: number): number {
    const x = Math.sin(id * 127.1 + i * 311.7 + salt * 74.7) * 43758.5453;
    return x - Math.floor(x);
}

/** How far everything that is not salient is knocked back. */
const SCRIM = "rgba(4, 8, 20, 0.62)";
/**
 * Every board highlight (a picked cell, a dragon's head and vision box, a
 * portal pair) uses this one stroke. The board is dark in both themes, so it
 * stays light rather than following the page's ink.
 */
export const SALIENT_STROKE = "rgba(236, 240, 245, 0.95)";
export const SALIENT_EDGE = "rgba(4, 12, 30, 0.7)";
const highlightWidth = (cell: number, zoom: number) => Math.max(1, cell * 0.065) / zoom;
const highlightDash = (cell: number, zoom: number) => [
    Math.max(2, cell * 0.18) / zoom,
    Math.max(2, cell * 0.12) / zoom,
];

/**
 * Strokes the current path as a highlight: a solid dark edge under the light
 * line, so it reads over white pearls as well as open water. Dashed lines keep
 * the edge solid, which also carries the line across the gaps.
 */
function strokeHighlight(ctx: CanvasRenderingContext2D, cell: number, zoom: number, dashed = false): void {
    const width = highlightWidth(cell, zoom);
    ctx.setLineDash([]);
    ctx.lineWidth = width + 2.5 / zoom;
    ctx.strokeStyle = SALIENT_EDGE;
    ctx.stroke();
    ctx.setLineDash(dashed ? highlightDash(cell, zoom) : []);
    ctx.lineWidth = width;
    ctx.strokeStyle = SALIENT_STROKE;
    ctx.stroke();
    ctx.setLineDash([]);
}

export const MAX_ZOOM = 8;
export const MIN_ZOOM = 0.05;

/** Largest the cached board layer may get on either side, in device pixels. */
const MAX_BOARD_LAYER_PX = 3072;
/** Most the board layer may outresolve the zoom-1 cell size. */
const MAX_BOARD_OVERSAMPLE = 4;

/**
 * Where the board sits in the viewport, in CSS pixels. `cell` is the board's
 * size at zoom 1; `originX`/`originY` are the board's top-left corner. Owned
 * by the view so DOM layers can project with the same numbers the canvas uses.
 */
export interface BoardCamera {
    cell: number;
    zoom: number;
    originX: number;
    originY: number;
}

/** Bubbles in one ping's burst, and in the short puff everyone else gets. */
const SONAR_BURST = 26;
const SONAR_SHORT_BURST = 10;
/** How far bubbles sit from the middle of the burst, in cells. */
const SONAR_CLUMP = 0.38;
/** The fraction of the step by which the burst has arrived. */
const SONAR_TRAVEL = 0.72;
/** A sheet tile as a fraction of a cell. The only thing that sets bubble size. */
const SONAR_BUBBLE_SPAN = 0.4;
/** How far a bursting bubble is thrown off the barrier, in cells. */
const SONAR_SPLASH = 0.5;
/** Bubbles left in each cell of a settled beam. A beam can be the width of the
 * board, so this is a residue the eye follows, not a second burst. */
const SONAR_SETTLED_PER_CELL = 3;

export default class GameRenderer {
    #canvas: HTMLCanvasElement;
    #ctx: CanvasRenderingContext2D;
    #mapSkin: MapSkin;
    #dragonSkin: DragonSkin;

    #layerCell = 0;
    #dpr = 1;
    #cols = 0;
    #rows = 0;

    // Cached board layer. #boardKey holds its scale and dimensions; the arrays
    // are the content it was painted from. Setting the key to '' forces a
    // repaint.
    #board: HTMLCanvasElement;
    #boardCtx: CanvasRenderingContext2D;
    #boardKey = "";
    #boardTiles: Uint8Array | null = null;
    #boardHEdges: Uint8Array | null = null;
    #boardVEdges: Uint8Array | null = null;

    constructor(
        canvas: HTMLCanvasElement,
        mapSkin: MapSkin = defaultMapSkin(),
        dragonSkin: DragonSkin = defaultDragonSkin(),
    ) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext("2d")!;
        this.#dragonSkin = dragonSkin;
        this.#board = document.createElement("canvas");
        this.#boardCtx = this.#board.getContext("2d")!;
        this.#mapSkin = mapSkin;
        this.#repaintBoardWhenReady(mapSkin);
    }

    /** Invalidate the cached board once a sprite skin's assets finish decoding. */
    #repaintBoardWhenReady(mapSkin: MapSkin): void {
        this.#boardKey = "";
        mapSkin.ready?.then(() => {
            if (this.#mapSkin === mapSkin) this.#boardKey = "";
        });
    }

    /** Swap skins. Only a map-skin change invalidates the cached board. */
    setSkins(mapSkin: MapSkin, dragonSkin: DragonSkin): void {
        if (mapSkin !== this.#mapSkin) {
            this.#mapSkin = mapSkin;
            this.#repaintBoardWhenReady(mapSkin);
        }
        this.#dragonSkin = dragonSkin;
    }

    get cellSize(): number {
        return this.#layerCell;
    }

    /** Match the canvas backing store to the viewport it fills, in CSS pixels. */
    resizeViewport(cssWidth: number, cssHeight: number): void {
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(cssWidth * dpr));
        const height = Math.max(1, Math.round(cssHeight * dpr));
        if (width === this.#canvas.width && height === this.#canvas.height && dpr === this.#dpr) return;
        this.#dpr = dpr;
        this.#canvas.width = width;
        this.#canvas.height = height;
    }

    /**
     * Size the cached board layer for `cols` × `rows` at `cell` CSS pixels per
     * cell. The camera scales this layer, so it only repaints when the base
     * cell size, DPR or board dimensions change.
     */
    #prepareBoardLayer(cell: number, cols: number, rows: number): void {
        if (cell === this.#layerCell && cols === this.#cols && rows === this.#rows) return;
        this.#layerCell = cell;
        this.#cols = cols;
        this.#rows = rows;
        this.#board.width = Math.max(1, Math.round(cell * cols * this.#dpr));
        this.#board.height = Math.max(1, Math.round(cell * rows * this.#dpr));
        this.#boardKey = "";
    }

    /**
     * How far to outresolve the zoom-1 cell so magnifying the cached board
     * layer stays sharp. Quantised to powers of two so panning and pinching
     * do not repaint it every frame, and capped so the bitmap stays sane.
     */
    #boardOversample(camera: BoardCamera, cols: number, rows: number): number {
        const wanted = Math.min(MAX_BOARD_OVERSAMPLE, Math.max(1, 2 ** Math.ceil(Math.log2(camera.zoom))));
        const longest = Math.max(cols, rows) * camera.cell * this.#dpr;
        let scale = wanted;
        while (scale > 1 && longest * scale > MAX_BOARD_LAYER_PX) scale /= 2;
        return scale;
    }

    #lastViews: DragonView[] = [];
    #lastCell = 1;

    /** Every dragon as drawn last frame: its team and the cells it covers. */
    drawnDragons(): { team: TeamId; cells: Vector[] }[] {
        return this.#lastViews.map((view) => ({ team: view.team, cells: view.occupancy.map((o) => o.cell) }));
    }

    /** Where a dragon's head was drawn last frame, mid-move included, in cells. */
    headOf(dragonId: number): Vector | undefined {
        const view = this.#lastViews.find((v) => v.id === dragonId);
        return view && { x: view.head.x / this.#lastCell, y: view.head.y / this.#lastCell };
    }

    /** Draw the round's timeline at instant `tau`. `timeMs` drives ambient animation. */
    draw(frame: TimelineFrame, timeMs: number, camera: BoardCamera, overlay: Overlay = {}): void {
        const { timeline, tau } = frame;
        const map = timeline.end.map;
        const oversample = this.#boardOversample(camera, map.width, map.height);
        this.#prepareBoardLayer(Math.max(1, Math.round(camera.cell * oversample)), map.width, map.height);

        const cell = camera.cell * this.#dpr;
        const sc: SkinContext = {
            cell,
            time: timeMs,
            portals: map.portals,
            board: map,
            suppressTorusDuplicates: true,
        };
        this.#ensureBoard(map, { ...sc, cell: this.#layerCell * this.#dpr, time: 0 });

        const ctx = this.#ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);

        // The cached layer holds `#layerCell` pixels per cell, so it needs its
        // own scale to land a cell where the sprites below put one.
        const layerScale = (camera.zoom * camera.cell) / this.#layerCell;
        ctx.setTransform(layerScale, 0, 0, layerScale, camera.originX * this.#dpr, camera.originY * this.#dpr);
        ctx.imageSmoothingEnabled = layerScale !== 1;
        ctx.drawImage(this.#board, 0, 0);
        ctx.imageSmoothingEnabled = false;

        ctx.setTransform(camera.zoom, 0, 0, camera.zoom, camera.originX * this.#dpr, camera.originY * this.#dpr);
        this.#drawTorusSeams(ctx, map.width, map.height, cell, camera.zoom);

        // Pearls first (dragons cover them). Dragons come in draw order:
        // dying ones underneath, then whoever entered a cell most recently on
        // top, so a head arriving where a tail is leaving reads the right way
        // round.
        for (const pearl of timeline.pearlViews(tau, cell)) {
            this.#mapSkin.drawPearl(ctx, pearl, sc);
        }
        const salient = overlay.salient ?? [];
        const annotated = new Set<number>(overlay.debugDragonIds);
        if (overlay.debugDragonIds === undefined) {
            for (const entity of salient) if (entity.kind === "dragon") annotated.add(entity.dragonId);
        }

        const views = timeline.views(tau, cell);
        this.#lastViews = views;
        this.#lastCell = cell;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, map.width * cell, map.height * cell);
        ctx.clip();
        for (const dragon of views) {
            resolveDragonSkin(this.#dragonSkin, dragon.team).drawDragon(ctx, dragon, sc);
        }
        ctx.restore();

        if (overlay.dim && salient.length > 0) {
            // Knock the whole scene back in screen space, then bring the salient
            // dragons forward again on top of the scrim.
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = SCRIM;
            ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
            ctx.setTransform(camera.zoom, 0, 0, camera.zoom, camera.originX * this.#dpr, camera.originY * this.#dpr);
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, map.width * cell, map.height * cell);
            ctx.clip();
            for (const entity of salient) {
                if (entity.kind !== "dragon") continue;
                const view = views.find((v) => v.id === entity.dragonId);
                if (view) resolveDragonSkin(this.#dragonSkin, view.team).drawDragon(ctx, view, sc);
            }
            ctx.restore();
        }

        // Cells and portals have no body of their own to redraw, so they are
        // marked instead — and the mark is what makes them salient whether or
        // not anything is dimmed.
        for (const entity of salient) {
            if (entity.kind === "portal") {
                this.#drawPortalPair(ctx, entity.ends, cell, camera.zoom);
            } else if (entity.kind === "cell") {
                ctx.beginPath();
                ctx.rect(entity.x * cell, entity.y * cell, cell, cell);
                strokeHighlight(ctx, cell, camera.zoom);
            }
        }
        this.#drawDragonSelections(ctx, salient, views, map.width, map.height, cell, camera.zoom);

        // Sonar is part of the match state, rather than selection-only debug UI.
        this.#drawPings(ctx, timeline, tau, cell, annotated);
        if (overlay.settledPings) this.#drawSettledPings(ctx, overlay.settledPings, cell, annotated);
        // What of the board is on screen, in board pixels, so labels can keep to it.
        const left = Math.max(0, (-camera.originX * this.#dpr) / camera.zoom);
        const top = Math.max(0, (-camera.originY * this.#dpr) / camera.zoom);
        const visible = {
            left,
            top,
            right: Math.min(map.width * cell, (this.#canvas.width - camera.originX * this.#dpr) / camera.zoom),
            bottom: Math.min(map.height * cell, (this.#canvas.height - camera.originY * this.#dpr) / camera.zoom),
        };
        this.#drawOverlay(
            ctx,
            views,
            cell,
            camera.zoom,
            timeline,
            tau,
            annotated,
            overlay.showAllIndicators ?? false,
            visible,
            overlay.outputTeam,
            overlay.theme ?? DEFAULT_THEME,
        );
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    /**
     * The bottom and right boundaries, dotted to mark a continuation rather
     * than a wall. The top and left get nothing: they are the same two
     * boundaries, so dotting them too would read as a frame.
     */
    #drawTorusSeams(ctx: CanvasRenderingContext2D, width: number, height: number, cell: number, zoom: number): void {
        ctx.save();
        ctx.strokeStyle = "rgba(190, 220, 230, 0.34)";
        ctx.lineWidth = Math.max(1, cell * 0.035) / zoom;
        ctx.setLineDash([Math.max(2, cell * 0.13) / zoom, Math.max(3, cell * 0.16) / zoom]);
        const inset = ctx.lineWidth;
        ctx.beginPath();
        ctx.moveTo(0, height * cell - inset);
        ctx.lineTo(width * cell, height * cell - inset);
        ctx.moveTo(width * cell - inset, 0);
        ctx.lineTo(width * cell - inset, height * cell);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * A thin box round each mouth of a portal pair and a dashed line between
     * them, drawn like the dragon selection and its vision box. The box keeps a
     * minimum size on screen so both ends can be found on a big board.
     */
    #drawPortalPair(ctx: CanvasRenderingContext2D, ends: readonly [Edge, Edge], cell: number, zoom: number): void {
        const px = this.#dpr / zoom;
        const boxes = ends.map((end) => {
            const [from, to] = edgeSegment(end, cell);
            const vertical = from.x === to.x;
            const along = Math.max(cell, 14 * px) / 2;
            const across = Math.max(cell * 0.3, 5 * px);
            return {
                x: (from.x + to.x) / 2,
                y: (from.y + to.y) / 2,
                hw: vertical ? across : along,
                hh: vertical ? along : across,
            };
        });
        ctx.save();
        ctx.beginPath();
        for (const box of boxes) ctx.rect(box.x - box.hw, box.y - box.hh, box.hw * 2, box.hh * 2);
        strokeHighlight(ctx, cell, zoom);

        const [a, b] = boxes;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        // From box edge to box edge, so it never runs through a box.
        const exit = (box: (typeof boxes)[number]) =>
            Math.min(dx ? box.hw / Math.abs(dx / length) : Infinity, dy ? box.hh / Math.abs(dy / length) : Infinity);
        const start = exit(a);
        const stop = length - exit(b);
        if (stop > start) {
            ctx.beginPath();
            ctx.moveTo(a.x + (dx / length) * start, a.y + (dy / length) * start);
            ctx.lineTo(a.x + (dx / length) * stop, a.y + (dy / length) * stop);
            strokeHighlight(ctx, cell, zoom, true);
        }
        ctx.restore();
    }

    /** Head square plus a wrapped 7×7 (radius-three) vision boundary. */
    #drawDragonSelections(
        ctx: CanvasRenderingContext2D,
        entities: readonly Entity[],
        views: DragonView[],
        width: number,
        height: number,
        cell: number,
        zoom: number,
    ): void {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width * cell, height * cell);
        ctx.clip();
        for (const entity of entities) {
            if (entity.kind !== "dragon") continue;
            const view = views.find((candidate) => candidate.id === entity.dragonId);
            if (!view) continue;
            const hx = Math.floor(view.head.x / cell);
            const hy = Math.floor(view.head.y / cell);
            ctx.beginPath();
            ctx.rect(hx * cell, hy * cell, cell, cell);
            strokeHighlight(ctx, cell, zoom);

            ctx.beginPath();
            for (const ox of [-width, 0, width]) {
                for (const oy of [-height, 0, height]) {
                    const x = hx - 3 + ox;
                    const y = hy - 3 + oy;
                    if (x >= width || y >= height || x + 7 <= 0 || y + 7 <= 0) continue;
                    ctx.rect(x * cell, y * cell, 7 * cell, 7 * cell);
                }
            }
            strokeHighlight(ctx, cell, zoom, true);
        }
        ctx.restore();
    }

    /**
     * Sonar as one burst of bubbles, breathed out the instant the ping is sent
     * and carried forward along the path the engine's cast took, so it goes
     * through portals and round the wrap, stops short of kelp and breaks on the
     * dragon it reached. Drawn under the dragons.
     *
     * The burst holds together as it travels — that is what makes it read as a
     * thing that was sent, rather than a haze — and only comes apart where it
     * lands. A selected dragon's ping runs the whole beam; everyone else's
     * carries one cell, so a busy board stays readable.
     */
    #drawPings(
        ctx: CanvasRenderingContext2D,
        timeline: RoundTimeline,
        tau: number,
        cell: number,
        selected: ReadonlySet<number>,
    ): void {
        const art = bubbleArt();
        if (!art) return;
        ctx.imageSmoothingEnabled = true;
        for (const ping of timeline.pings) {
            if (tau < ping.at.start || tau >= ping.at.end) continue;
            const { path } = ping;
            const full = selected.has(ping.senderId);
            const reach = full ? path.length - 1 : Math.min(path.length - 1, 1);
            if (reach <= 0) continue;
            const hits = full && ping.hitId !== undefined;
            const count = full ? SONAR_BURST : SONAR_SHORT_BURST;
            const size = full ? 1 : 0.85;
            const p = RoundTimeline.progress(ping.at, tau);
            const heading = DIRECTION_DELTA[ping.direction];
            const along = alongPath(path, reach, heading, cell);
            // Where the middle of the burst is, and how far it is past the end.
            const centre = (p / SONAR_TRAVEL) * reach;
            const over = Math.max(0, (p - SONAR_TRAVEL) / (1 - SONAR_TRAVEL));
            const fade = Math.min(1, p / 0.04) * (1 - over ** 1.6);
            if (fade <= 0.02) continue;

            for (let n = 0; n < count; n++) {
                // A fixed scatter that rides along with the burst, so the
                // bubbles keep their arrangement instead of smearing out.
                const ahead = SONAR_CLUMP * (roll(ping.senderId, n, 0) * 2 - 1);
                const across = SONAR_CLUMP * (roll(ping.senderId, n, 1) * 2 - 1);
                const d = Math.min(centre + ahead, reach);
                if (d < 0.1) continue;
                // Where it lands the burst comes apart, thrown off the barrier.
                const splash = over * SONAR_SPLASH * (roll(ping.senderId, n, 3) * 2 - 1) * (hits ? 1.6 : 1);
                const wobble = 0.05 * Math.sin(d * 9 + p * 6 + roll(ping.senderId, n, 2) * Math.PI * 2);
                const off = cell * (across + splash + wobble);
                const at = {
                    x: along(d).x - heading.y * off - heading.x * over * cell * 0.3,
                    y: along(d).y + heading.x * off - heading.y * over * cell * 0.3,
                };
                const side = cell * SONAR_BUBBLE_SPAN * size * (1 + over * (hits ? 0.5 : 0.25));
                drawBubble(ctx, art, at, side, fade, Math.floor(roll(ping.senderId, n, 5) * BUBBLE_SPRITES));
            }
        }
    }

    /** A bubble's place in a settled beam: scattered in its cell, held still. */
    #scatter(at: Vector, heading: Vector, cell: number, id: number, n: number): Vector {
        const off = cell * SONAR_CLUMP * (roll(id, n, 1) * 2 - 1);
        const slide = cell * SONAR_CLUMP * (roll(id, n, 0) * 2 - 1);
        return {
            x: at.x - heading.y * off + heading.x * slide,
            y: at.y + heading.x * off + heading.y * slide,
        };
    }

    /**
     * Pings from the step just finished, held still for a paused board: the
     * travelling burst only exists inside a step, and a paused board always
     * sits between two. A selected dragon's ping leaves a few bubbles in every
     * cell to the end of its path, fattened on the dragon it reached; the rest
     * keep their one puff.
     */
    #drawSettledPings(
        ctx: CanvasRenderingContext2D,
        pings: readonly Ping[],
        cell: number,
        selected: ReadonlySet<number>,
    ): void {
        const art = bubbleArt();
        if (!art) return;
        ctx.imageSmoothingEnabled = true;
        for (const ping of pings) {
            const full = selected.has(ping.senderId);
            const reach = full ? ping.path.length - 1 : Math.min(ping.path.length - 1, 1);
            if (reach <= 0) continue;
            const size = full ? 1 : 0.85;
            const heading = DIRECTION_DELTA[ping.direction];
            const along = alongPath(ping.path, reach, heading, cell);
            for (let d = 1; d <= reach; d++) {
                for (let j = 0; j < SONAR_SETTLED_PER_CELL; j++) {
                    const n = d * SONAR_SETTLED_PER_CELL + j;
                    const end = d === reach && full && ping.hitId !== undefined;
                    const alpha = end ? 1 : 1 - 0.2 * (d / reach);
                    drawBubble(
                        ctx,
                        art,
                        this.#scatter(along(d), heading, cell, ping.senderId, n),
                        cell * SONAR_BUBBLE_SPAN * size * (end ? 1.25 : 1),
                        alpha,
                        Math.floor(roll(ping.senderId, n, 5) * BUBBLE_SPRITES),
                    );
                }
            }
        }
    }

    /** Bot drawings, then a ring and status line, for every annotated dragon. */
    #drawOverlay(
        ctx: CanvasRenderingContext2D,
        views: DragonView[],
        cell: number,
        zoom: number,
        timeline: RoundTimeline,
        tau: number,
        annotated: ReadonlySet<number>,
        showAllIndicators: boolean,
        visible: { left: number; top: number; right: number; bottom: number },
        outputTeam: TeamId | undefined,
        theme: BoardTheme,
    ): void {
        const teamOf = new Map(views.map((view) => [view.id, view.team]));
        const theirs = (id: number) => outputTeam !== undefined && teamOf.get(id) !== outputTeam;
        const { width: cols, height: rows } = timeline.end.map;
        const { draws, indicators } = timeline.effectsAt(tau);
        // The engine passes a bot's coordinates through as sent, and the board
        // wraps, so a line takes the short way round and every drawing is
        // repeated a board over in each direction, clipped like the vision box.
        const shortest = (d: number, n: number) => d - n * Math.round(d / n);

        // Strokes and text are divided by the zoom so they keep the same weight
        // on screen however far in the camera is.
        // Drawings belong to a dragon you have singled out; en masse they are
        // noise, so nothing renders until the dragon is pinned or hovered.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cols * cell, rows * cell);
        ctx.clip();
        for (const drawing of draws) {
            if (!annotated.has(drawing.id) || theirs(drawing.id)) continue;
            const { draw } = drawing;
            ctx.strokeStyle = `rgb(${draw.red} ${draw.green} ${draw.blue})`;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = Math.max(1, cell * 0.12) / zoom;
            ctx.lineCap = "round";
            const fx = (((draw.from.x % cols) + cols) % cols) + 0.5;
            const fy = (((draw.from.y % rows) + rows) % rows) + 0.5;
            const tx = fx + shortest(draw.to.x - draw.from.x, cols);
            const ty = fy + shortest(draw.to.y - draw.from.y, rows);
            ctx.beginPath();
            for (const ox of [-cols, 0, cols]) {
                for (const oy of [-rows, 0, rows]) {
                    if (draw.shape === DebugShape.Dot) {
                        const r = Math.max(1.5, cell * 0.22);
                        ctx.moveTo((fx + ox) * cell + r, (fy + oy) * cell);
                        ctx.arc((fx + ox) * cell, (fy + oy) * cell, r, 0, Math.PI * 2);
                    } else {
                        ctx.moveTo((fx + ox) * cell, (fy + oy) * cell);
                        ctx.lineTo((tx + ox) * cell, (ty + oy) * cell);
                    }
                }
            }
            if (draw.shape === DebugShape.Dot) ctx.fill();
            else ctx.stroke();
        }
        ctx.restore();

        const indicatorIds = showAllIndicators ? views.map((view) => view.id) : [...annotated];
        for (const dragonId of indicatorIds) {
            if (theirs(dragonId)) continue;
            const view = views.find((v) => v.id === dragonId);
            if (!view) continue;

            const status = indicators.get(dragonId);
            if (!status) continue;
            // The tooltip's plate and type: 12px on screen at any zoom.
            const size = (12 * this.#dpr) / zoom;
            ctx.font = `${size}px ${theme.font}`;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            const label = `${dragonId}: ${status}`;
            const pad = size * 0.3;
            const boxWidth = ctx.measureText(label).width + pad * 2;
            const boxHeight = size * 1.35;
            // Above the head, unless that runs off the top of what's visible;
            // centred on it, but slid sideways to stay on screen at the edges.
            const gap = cell * 0.6;
            let y = view.head.y - gap - boxHeight;
            if (y < visible.top) y = view.head.y + gap;
            const x = Math.max(visible.left, Math.min(view.head.x - boxWidth / 2, visible.right - boxWidth));
            ctx.fillStyle = theme.panel;
            ctx.fillRect(x, y, boxWidth, boxHeight);
            ctx.strokeStyle = theme.rule;
            ctx.lineWidth = this.#dpr / zoom;
            ctx.strokeRect(x, y, boxWidth, boxHeight);
            ctx.fillStyle = theme.ink;
            ctx.fillText(label, x + pad, y + boxHeight / 2);
        }
    }

    /**
     * Repaint the cached board layer if the board content or scale changed.
     * Pearls are excluded (drawn per frame).
     */
    #ensureBoard(map: CurrentMap, sc: SkinContext): void {
        const key = `${sc.cell}|${map.width}x${map.height}`;
        if (
            key === this.#boardKey &&
            sameBytes(map.tiles, this.#boardTiles) &&
            sameBytes(map.hEdges, this.#boardHEdges) &&
            sameBytes(map.vEdges, this.#boardVEdges)
        ) {
            return;
        }
        this.#boardKey = key;
        this.#boardTiles = map.tiles;
        this.#boardHEdges = map.hEdges;
        this.#boardVEdges = map.vEdges;
        this.#boardCtx.clearRect(0, 0, this.#board.width, this.#board.height);
        this.#mapSkin.drawBoard(this.#boardCtx, map, { ...sc, time: 0 });
    }
}

function sameBytes(a: Uint8Array, b: Uint8Array | null): boolean {
    if (a === b) return true;
    if (!b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
