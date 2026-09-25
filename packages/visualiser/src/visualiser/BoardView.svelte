<!--
	The board's viewport. Owns the camera and fills whatever space it is given;
	the board floats inside it and can be panned and zoomed anywhere. The camera
	is plain reactive state in CSS pixels, and `project`/`unproject` are handed
	to the `overlay` snippet so DOM layers can sit on the board using the same
	numbers the canvas draws with.
-->
<script lang="ts">
    import { onMount, type Snippet } from "svelte";
    import GameRenderer, {
        MAX_ZOOM,
        MIN_ZOOM,
        SALIENT_EDGE,
        SALIENT_STROKE,
        type BoardCamera,
        type BoardTheme,
    } from "./GameRenderer";
    import type GameRunner from "./GameRunner.svelte";
    import type Match from "./Match";
    import { DEFAULT_STAGGER } from "./constants";
    import { resolveDragonSkin } from "./Skins";
    import type { MapSkin, DragonSkin } from "./Skins";
    import type { Vector } from "./Vector";
    import { entityAt, type Entity } from "./Entities";
    import { TEAM_COLORS } from "../replay/loader";

    export interface BoardProjection {
        /** Board coordinates (cells, fractional allowed) to CSS pixels in the viewport. */
        project: (boardX: number, boardY: number) => Vector;
        /** CSS pixels in the viewport back to board coordinates. */
        unproject: (cssX: number, cssY: number) => Vector;
        /** CSS pixels per cell on screen right now. */
        scale: number;
        camera: BoardCamera;
        viewport: { width: number; height: number };
    }

    let {
        match,
        runner,
        position = 0,
        mapSkin,
        dragonSkin,
        minCell = 6,
        maxCell = 44,
        salient,
        dim = false,
        debugDragonIds,
        showAllIndicators = false,
        onhover,
        onpick,
        overlay,
        class: className = "",
    }: {
        match: Match;
        runner?: GameRunner;
        /** Float position for controlled use; ignored when `runner` is set. */
        position?: number;
        mapSkin: MapSkin;
        dragonSkin: DragonSkin;
        /** Bounds on the cell size that counts as zoom 1. */
        minCell?: number;
        maxCell?: number;
        /** Entities drawn salient: the hovered one, or every pinned one. */
        salient?: readonly Entity[];
        /** Dim everything that is not salient. Set only while something is hovered. */
        dim?: boolean;
        /** Selected dragons whose bot drawings and status text should be visible. */
        debugDragonIds?: readonly number[];
        /** Draw every bot status indicator, not just selected dragons. */
        showAllIndicators?: boolean;
        onhover?: (entity: Entity | undefined, at: Vector) => void;
        onpick?: (entity: Entity, at: Vector) => void;
        /** DOM layer drawn over the board, positioned with the same camera. */
        overlay?: Snippet<[BoardProjection]>;
        class?: string;
    } = $props();

    let root: HTMLDivElement | undefined = $state();
    let canvas: HTMLCanvasElement | undefined = $state();

    let viewport = $state({ width: 0, height: 0 });
    let zoom = $state(1);
    let originX = $state(0);
    let originY = $state(0);
    /**
     * True while the camera is still the automatic framing rather than a place
     * the viewer panned or zoomed to. The board re-centres on every resize
     * until someone moves it; Escape hands it back.
     */
    let framed = true;

    const board = $derived(match.roundAt(0).map);

    /**
     * Cell size in CSS pixels that makes the board fill the viewport at zoom 1.
     * Whole pixels only: a fractional cell puts every tile edge on a half
     * device pixel and the board layer rasterises soft.
     */
    const baseCell = $derived.by(() => {
        if (!viewport.width || !viewport.height) return minCell;
        const byWidth = viewport.width / board.width;
        const byHeight = viewport.height / board.height;
        return Math.max(minCell, Math.min(maxCell, Math.floor(Math.min(byWidth, byHeight))));
    });

    const scale = $derived(baseCell * zoom);
    const camera = $derived<BoardCamera>({ cell: baseCell, zoom, originX, originY });

    const project = (boardX: number, boardY: number): Vector => ({
        x: originX + boardX * scale,
        y: originY + boardY * scale,
    });

    const unproject = (cssX: number, cssY: number): Vector => ({
        x: (cssX - originX) / scale,
        y: (cssY - originY) / scale,
    });

    const projection = $derived<BoardProjection>({ project, unproject, scale, camera, viewport });

    export function resetCamera(): void {
        framed = true;
        zoom = 1;
        centreBoard();
    }

    function centreBoard(): void {
        originX = (viewport.width - board.width * baseCell * zoom) / 2;
        originY = (viewport.height - board.height * baseCell * zoom) / 2;
    }

    function zoomAt(cssX: number, cssY: number, factor: number): void {
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
        if (next === zoom) return;
        framed = false;
        const anchor = unproject(cssX, cssY);
        zoom = next;
        originX = cssX - anchor.x * baseCell * next;
        originY = cssY - anchor.y * baseCell * next;
    }

    // Paused on a step boundary, the pings of the step just finished, to hold
    // on the board: a step's moving crests are gone by its end.
    function settledPings() {
        if (!runner || runner.playing || !Number.isInteger(runner.position) || runner.position <= 0) return undefined;
        const before = match.frameAt(runner.position - 1e-6, runner.granularity, runner.stagger);
        const { start, end } = before.window;
        return before.timeline.pings.filter((ping) => ping.at.start < end && ping.at.end > start);
    }

    function currentFrame() {
        return runner
            ? match.frameAt(runner.position, runner.granularity, runner.stagger)
            : match.frameAt(position, "round", DEFAULT_STAGGER);
    }

    const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "password", "number", "tel"]);

    function isTextEditing(target: HTMLElement): boolean {
        if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
        return target.tagName === "INPUT" && TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
    }

    // Shift steps ten at a time.
    function stepOnArrowKey(e: KeyboardEvent): boolean {
        if (!runner) return false;
        const by = e.shiftKey ? 10 : 1;
        if (e.code === "ArrowLeft") runner.step(-by);
        else if (e.code === "ArrowRight") runner.step(by);
        else return false;
        e.preventDefault();
        return true;
    }

    function handleWindowKeydown(e: KeyboardEvent) {
        if (e.defaultPrevented) return;
        if (e.key === "Escape") {
            if (runner) runner.followDragonId = undefined;
            resetCamera();
            return;
        }
        const target = e.target as HTMLElement | null;
        if (target && isTextEditing(target)) return;
        if (target?.tagName === "BUTTON" && (e.code === "Space" || e.code === "Enter")) return;
        stepOnArrowKey(e);
    }

    let dragging = false;
    let dragMoved = 0;
    let lastPointer = { x: 0, y: 0 };

    function localPoint(e: { clientX: number; clientY: number }): Vector {
        const rect = canvas!.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handleWheel(e: WheelEvent) {
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        const at = localPoint(e);
        zoomAt(at.x, at.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }

    function handlePointerDown(e: PointerEvent) {
        dragging = true;
        dragMoved = 0;
        lastPointer = { x: e.clientX, y: e.clientY };
        canvas!.setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e: PointerEvent) {
        const at = localPoint(e);
        if (!dragging) {
            reportHover(at);
            return;
        }
        const dx = e.clientX - lastPointer.x;
        const dy = e.clientY - lastPointer.y;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        lastPointer = { x: e.clientX, y: e.clientY };
        framed = false;
        originX += dx;
        originY += dy;
        // Panning by hand takes the camera back from a followed dragon.
        if (dragMoved > 4 && runner?.followDragonId !== undefined) runner.followDragonId = undefined;
        // Dragging the board is not pointing at anything on it.
        if (dragMoved > 4) onhover?.(undefined, at);
    }

    function reportHover(at: Vector) {
        if (!onhover) return;
        const point = unproject(at.x, at.y);
        onhover(entityAt(point, currentFrame(), match.roundAt(0).map), at);
    }

    function handlePointerLeave(e: PointerEvent) {
        onhover?.(undefined, localPoint(e));
    }

    // A press that barely moved is a click, which selects whatever dragon is
    // under it; a press that travelled was a pan.
    function handlePointerUp(e: PointerEvent) {
        if (!dragging) return;
        dragging = false;
        canvas!.releasePointerCapture(e.pointerId);
        if (dragMoved > 4) return;

        const at = localPoint(e);
        const entity = entityAt(unproject(at.x, at.y), currentFrame(), match.roundAt(0).map);
        if (entity) onpick?.(entity, at);
    }

    // Following a dragon: the camera chases the head as drawn, mid-move
    // included, so it glides with the dragon instead of stepping a cell a
    // round. It zooms in if the board was framed whole. A jump of more than
    // half the board is the dragon wrapping round an edge, so it cuts there.
    $effect(() => {
        if (runner?.followDragonId === undefined) return;
        framed = false;
        if (zoom < 2.5) zoom = 3;
    });

    function follow(dragonId: number, head: Vector | undefined, dt: number) {
        if (!head) {
            const cell = currentFrame().timeline.end.bodies.getById(dragonId)?.body[0];
            // Gone from the board: it died, so there's nothing left to follow.
            if (!cell) {
                if (runner) runner.followDragonId = undefined;
                return;
            }
            head = { x: cell.x + 0.5, y: cell.y + 0.5 };
        }
        const targetX = viewport.width / 2 - head.x * scale;
        const targetY = viewport.height / 2 - head.y * scale;
        const far =
            Math.abs(targetX - originX) > (board.width * scale) / 2 ||
            Math.abs(targetY - originY) > (board.height * scale) / 2;
        // The same glide at any frame rate: most of the way there in ~0.3s.
        const ease = far ? 1 : 1 - Math.exp(-dt * 10);
        originX += (targetX - originX) * ease;
        originY += (targetY - originY) * ease;
    }

    // Minimap: once the board no longer fits, a small whole-board view in the
    // corner with every dragon and a box for what's on screen. Click it to go
    // there.
    const MINIMAP_SIZE = 140;
    let minimap: HTMLCanvasElement | undefined = $state();
    const showMinimap = $derived(
        board.width * scale > viewport.width + 1 || board.height * scale > viewport.height + 1,
    );
    const minimapCell = $derived(MINIMAP_SIZE / Math.max(board.width, board.height));

    // Drawn from what the board itself just drew, not the round's end state,
    // so the two never disagree mid-move.
    function drawMinimap(renderer: GameRenderer) {
        const ctx = minimap?.getContext("2d");
        if (!ctx || !minimap) return;
        const dpr = window.devicePixelRatio || 1;
        const width = Math.round(board.width * minimapCell);
        const height = Math.round(board.height * minimapCell);
        if (minimap.width !== width * dpr) minimap.width = width * dpr;
        if (minimap.height !== height * dpr) minimap.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#1c3a6b";
        ctx.fillRect(0, 0, width, height);
        const size = Math.max(1.5, minimapCell);
        for (const dragon of renderer.drawnDragons()) {
            ctx.fillStyle = resolveDragonSkin(dragonSkin, dragon.team).color ?? TEAM_COLORS[dragon.team];
            for (const part of dragon.cells) ctx.fillRect(part.x * minimapCell, part.y * minimapCell, size, size);
        }
        const from = unproject(0, 0);
        const to = unproject(viewport.width, viewport.height);
        // The board's highlight: a light line on a dark edge.
        const box = [
            from.x * minimapCell,
            from.y * minimapCell,
            (to.x - from.x) * minimapCell,
            (to.y - from.y) * minimapCell,
        ] as const;
        ctx.strokeStyle = SALIENT_EDGE;
        ctx.lineWidth = 3;
        ctx.strokeRect(...box);
        ctx.strokeStyle = SALIENT_STROKE;
        ctx.lineWidth = 1;
        ctx.strokeRect(...box);
    }

    function minimapJump(e: PointerEvent) {
        if (e.type === "pointermove" && !e.buttons) return;
        const rect = minimap!.getBoundingClientRect();
        const cellX = (e.clientX - rect.left) / minimapCell;
        const cellY = (e.clientY - rect.top) / minimapCell;
        if (runner) runner.followDragonId = undefined;
        framed = false;
        originX = viewport.width / 2 - cellX * scale;
        originY = viewport.height / 2 - cellY * scale;
    }

    onMount(() => {
        const measure = () => {
            if (!root) return;
            viewport = { width: root.clientWidth, height: root.clientHeight };
            // Re-frame, not just place once: the host sizes this box in more
            // than one pass, so a camera centred on the first measurement is
            // left pointing at a corner of the final one.
            if (viewport.width > 0 && framed) centreBoard();
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(root!);
        return () => ro.disconnect();
    });

    // The canvas can't read CSS, so the theme's colours are read off the page
    // once and again whenever the theme switches.
    let theme: BoardTheme | undefined;
    function readTheme() {
        if (!root) return;
        const style = getComputedStyle(root);
        const token = (name: string) => style.getPropertyValue(name).trim();
        theme = {
            panel: token("--vis-base-200"),
            ink: token("--vis-ink"),
            rule: token("--vis-rule"),
            font: style.fontFamily,
        };
    }

    onMount(() => {
        readTheme();
        const watcher = new MutationObserver(readTheme);
        watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
        return () => watcher.disconnect();
    });

    onMount(() => {
        const renderer = new GameRenderer(canvas!, mapSkin, dragonSkin);
        let raf = 0;
        let last = performance.now();

        const loop = (now: number) => {
            raf = requestAnimationFrame(loop);
            // Clamp dt after a backgrounded tab wakes up to avoid a fast-forward.
            const dt = Math.min((now - last) / 1000, 0.25);
            last = now;

            runner?.tick(dt);
            if (runner?.followDragonId !== undefined)
                follow(runner.followDragonId, renderer.headOf(runner.followDragonId), dt);
            renderer.setSkins(mapSkin, dragonSkin);
            renderer.resizeViewport(viewport.width, viewport.height);
            renderer.draw(currentFrame(), now, camera, {
                salient,
                dim,
                debugDragonIds,
                showAllIndicators,
                outputTeam: runner?.outputTeam,
                theme,
                settledPings: settledPings(),
            });
            if (showMinimap) drawMinimap(renderer);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div bind:this={root} class="board-view {className}">
    <canvas
        bind:this={canvas}
        onwheel={handleWheel}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={handlePointerUp}
        onpointerleave={handlePointerLeave}
    ></canvas>
    <div class="overlay">
        {@render overlay?.(projection)}
    </div>
    {#if showMinimap}
        <canvas
            class="minimap"
            bind:this={minimap}
            style:width="{board.width * minimapCell}px"
            style:height="{board.height * minimapCell}px"
            onpointerdown={minimapJump}
            onpointermove={minimapJump}
            aria-label="Minimap: click to move the view"
        ></canvas>
    {/if}
</div>

<style>
    .board-view {
        position: relative;
        flex: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        /* Not themed, and deliberately: the canvas covers this box entirely,
           so all this paints is the frame before the first draw. It matches
           the skin's own water rather than the page. */
        background: #0a1424;
    }

    canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
        cursor: grab;
        touch-action: none;
    }

    canvas:active {
        cursor: grabbing;
    }

    /* Bottom right, over the board; a rule keeps it apart from the water. */
    .minimap {
        inset: auto 10px 10px auto;
        border: 1px solid #c9d4e0;
        cursor: pointer;
    }

    /* Layers sit on the board; they opt back into the pointer themselves so
	   dragging the board still works through the gaps between them. */
    .overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
    }
</style>
