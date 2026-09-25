<script lang="ts">
    import { onDestroy } from "svelte";
    import { StaticMap, CurrentMap, dragonFacing, type Edge } from "../visualiser/Map";
    import { Bodies, settledDragonViews } from "../visualiser/Bodies";
    import { resolveDragonSkin, edgeBar, portalPairColor, type SkinContext } from "../visualiser/Skins";
    import { clamp } from "../visualiser/Vector";
    import { mapSkins, teamDragonSkins } from "../skins/index";
    import { settings } from "../settings.svelte";
    import {
        editor,
        editorUi,
        pearlsVisible,
        editorStaticMap,
        edgeInRange,
        paint,
        placementIssue,
        affectedEdges,
        brushValue,
        commitDragonDraft,
        cancelDragonDraft,
        mirrorTile,
        mirroredEdges,
        toBoardEdge,
        type Modifiers,
        type Target,
    } from "../mapEditor.svelte";
    import { beginEdit, endEdit, cancelEdit, edit } from "../editorHistory.svelte";
    import {
        selection,
        contains,
        rectangleBetween,
        placeSelection,
        placementReview,
        placementGhost,
        clearSelection,
        type Rectangle,
        type Objects as SelectionObjects,
    } from "../editorSelection.svelte";

    let { map, error }: { map?: CurrentMap; error?: string } = $props();
    let canvasWrapper: HTMLElement | undefined = $state();
    let canvas: HTMLCanvasElement | undefined = $state();
    let availW = $state(600);
    let availH = $state(600);
    // What the pointer is over, and the modifiers held when it got there. Both
    // feed the ghost, so holding ctrl re-colours it on the next mouse move.
    let hover: Target | undefined = $state();
    let hoverMods: Modifiers = $state({ ctrl: false, shift: false });

    const mapSkin = $derived(mapSkins.get(settings.mapSkinName));
    const dragonSkin = $derived(teamDragonSkins.getBothTeamSkins(settings.teamASkinName, settings.teamBSkinName));
    // Floors at 4px rather than 20 so a 64x64 board still fits the stage.
    const fittedCell = $derived(clamp(Math.floor(Math.min(availW / editor.w, availH / editor.h)), 4, 64));
    let zoom = $state(1);
    const cellSize = $derived(clamp(Math.round(fittedCell * zoom), 4, 64));

    const hoverIssue = $derived(selection.tool === "paint" && hover ? placementIssue(hover, hoverMods) : undefined);

    /** How much of its colour an out-of-layer element keeps. */
    const OUT_OF_LAYER_ALPHA = 0.22;

    /**
     * The chosen layer on its own, or undefined when showing everything.
     */
    const focusedMap = $derived.by(() => {
        if (editor.layer === "all") return undefined;
        try {
            return new CurrentMap(
                editorStaticMap({ kelp: editor.layer === "kelp", portals: editor.layer === "portals" }),
            );
        } catch {
            return undefined;
        }
    });

    // Ghost colours: what the brush would leave behind, or red when it can't.
    const GHOST_KELP = "rgba(150, 233, 226, 0.72)";
    const GHOST_PORTAL = "rgba(126, 190, 255, 0.78)";
    const GHOST_ERASE = "rgba(255, 196, 106, 0.7)";
    const GHOST_INVALID = "rgba(255, 96, 84, 0.85)";
    const TEAM_DRAFT_RGB = { 0: "150, 233, 226", 1: "255, 196, 106" } as const;
    const draftColor = (team: 0 | 1, alpha: number) => `rgba(${TEAM_DRAFT_RGB[team]}, ${alpha})`;
    const HOVER_WASH = "rgba(150, 233, 226, 0.22)";
    const SELECT_FILL = "rgba(100, 190, 255, 0.16)";
    const SELECT_LINE = "#8fd5ff";
    const ILLEGAL_LINE = "#ff9aa2";
    const CONFLICT_FILL = "rgba(255, 92, 104, 0.45)";
    const GHOST_PEARL = "rgba(240, 226, 189, 0.32)";

    // Sprite sheets decode asynchronously; until they do, skins fall back to
    // their vector look. Bumping this on resolve re-triggers a repaint, as
    // GameRenderer's #repaintBoardWhenReady does for the Visualiser.
    let skinReadyTick = $state(0);
    $effect(() => {
        for (const skin of [mapSkin, dragonSkin.teamA, dragonSkin.teamB]) {
            skin.ready?.then(() => (skinReadyTick += 1));
        }
    });

    $effect(() => {
        if (!canvasWrapper) return;
        const ro = new ResizeObserver(([entry]) => {
            availW = entry.contentRect.width;
            availH = entry.contentRect.height;
        });
        ro.observe(canvasWrapper);
        return () => ro.disconnect();
    });

    // Only board changes rebuild this layer. Hover and drafts just blit it.
    const boardLayer = $derived.by(() => {
        if (typeof document === "undefined") return undefined;
        void skinReadyTick;
        const dpr = window.devicePixelRatio || 1;
        const cssW = editor.w * cellSize;
        const cssH = editor.h * cellSize;

        const layer = document.createElement("canvas");
        layer.width = Math.round(cssW * dpr);
        layer.height = Math.round(cssH * dpr);
        const layerCtx = layer.getContext("2d")!;
        layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (map) {
            const sc = { cell: cellSize, time: 0, portals: map.portals, board: map, suppressTorusDuplicates: true };
            if (focusedMap) {
                mapSkin.drawBoard(layerCtx, focusedMap, {
                    ...sc,
                    portals: focusedMap.portals,
                    board: focusedMap,
                });
                layerCtx.globalAlpha = OUT_OF_LAYER_ALPHA;
                mapSkin.drawBoard(layerCtx, map, sc);
                layerCtx.globalAlpha = 1;
            } else {
                mapSkin.drawBoard(layerCtx, map, sc);
            }
            drawSeams(layerCtx);
            // Spawns are an indicator of where the file puts them rather than
            // part of the board, so they stay held back even on `all`; only
            // their own layer brings them up to full.
            drawSpawnDragons(
                layerCtx,
                map,
                sc,
                editor.layer === "dragons" ? 1 : editor.layer === "all" ? 0.6 : OUT_OF_LAYER_ALPHA,
            );
            if (pearlsVisible()) {
                drawPearlNumbers(layerCtx, map.staticMap);
            }
            if (editor.layer === "portals") {
                drawPortalLinks(layerCtx, map.staticMap);
                drawPortalLabels(layerCtx, map.staticMap);
            }
        }
        return { layer, cssW, cssH, dpr };
    });

    $effect(() => {
        if (!canvas || !boardLayer) return;
        const { layer, cssW, cssH, dpr } = boardLayer;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        // Resizing clears the context and reallocates its buffer. Hover does neither.
        if (canvas.width !== layer.width) canvas.width = layer.width;
        if (canvas.height !== layer.height) canvas.height = layer.height;
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(layer, 0, 0, cssW, cssH);
        ctx.save();
        if (map) drawHoveredDragons(ctx, map);
        drawDragonDraft(ctx);
        drawPendingPortal(ctx);
        if (selection.tool === "paint" && map) drawGhost(ctx);
        drawSelection(ctx, map);
        ctx.restore();
    });

    let gesture:
        | { kind: "select" | "move"; start: [number, number]; current: [number, number]; initial?: Rectangle }
        | undefined = $state();

    function destination() {
        const paste = selection.pasting && !!selection.clipboard;
        let at: [number, number] | undefined;
        if (paste && hover) at = [hover.x, hover.y];
        else if (gesture?.kind === "move" && gesture.initial)
            at = [gesture.current[0] - gesture.start[0], gesture.current[1] - gesture.start[1]];
        if (!at) return undefined;
        const ghost = placementGhost(at[0], at[1], paste);
        return ghost ? { ghost, ...placementReview(at[0], at[1], paste) } : undefined;
    }

    function outlineRectangle(ctx: CanvasRenderingContext2D, rect: Rectangle, fill: string, line: string) {
        ctx.fillStyle = fill;
        ctx.strokeStyle = line;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.fillRect(rect.x * cellSize, rect.y * cellSize, rect.width * cellSize, rect.height * cellSize);
        ctx.strokeRect(
            rect.x * cellSize + 1,
            rect.y * cellSize + 1,
            rect.width * cellSize - 2,
            rect.height * cellSize - 2,
        );
        ctx.setLineDash([]);
    }

    function drawSelection(ctx: CanvasRenderingContext2D, map?: CurrentMap) {
        if (selection.tool !== "select") return;
        const target = destination();
        const rect = selection.rectangle;
        if (rect && !(target && selection.pasting)) {
            ctx.globalAlpha = target ? 0.4 : 1;
            outlineRectangle(ctx, rect, SELECT_FILL, SELECT_LINE);
            ctx.globalAlpha = 1;
        }
        if (!target) return;
        outlineRectangle(ctx, target.ghost.bounds, SELECT_FILL, target.legal ? SELECT_LINE : ILLEGAL_LINE);
        drawGhostObjects(ctx, target.ghost, map);
        ctx.fillStyle = CONFLICT_FILL;
        for (const [x, y] of target.conflicts) ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }

    function drawGhostObjects(ctx: CanvasRenderingContext2D, ghost: SelectionObjects, map?: CurrentMap) {
        for (const [x, y] of ghost.kelp) edgeBar(ctx, toBoardEdge(x, y), cellSize, GHOST_KELP);
        for (const pair of ghost.portals)
            for (const [x, y] of pair) edgeBar(ctx, toBoardEdge(x, y), cellSize, GHOST_PORTAL);
        ctx.fillStyle = GHOST_PEARL;
        for (const { at } of ghost.pearls) ctx.fillRect(at[0] * cellSize, at[1] * cellSize, cellSize, cellSize);
        if (!map || !ghost.dragons.length) return;
        const bodies = ghost.dragons.map((dragon, id) => {
            const body = dragon.body.map(([x, y]) => ({ x, y }));
            return {
                id,
                team: dragon.team === 0 ? ("A" as const) : ("B" as const),
                facing: dragonFacing(body, editor.w, editor.h),
                body,
            };
        });
        const sc = { cell: cellSize, time: 0, portals: map.portals, board: map, suppressTorusDuplicates: true };
        for (const view of settledDragonViews(new Bodies(bodies), cellSize, map.portals, map))
            resolveDragonSkin(dragonSkin, view.team).drawDragon(ctx, { ...view, alpha: 0.55 }, sc);
    }

    /**
     * Portal number beside each portal boundary, so partners are identifiable.
     */
    function drawPortalLabels(ctx: CanvasRenderingContext2D, map: StaticMap) {
        if (cellSize < 14) return;
        ctx.font = `${portalLabelSize()}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(2, cellSize * 0.08);
        ctx.strokeStyle = "rgba(6, 12, 24, 0.85)";
        map.portals.forEach(([a, b], index) => {
            const label = String(map.portalLabels[index]);
            for (const edge of [a, b]) {
                const { x, y } = labelPoint(edge);
                // Outlined: the label sits where its connector line meets the
                // boundary, so it would otherwise read through the line.
                ctx.strokeText(label, x, y);
                ctx.fillStyle = "rgba(210, 232, 255, 0.9)";
                ctx.fillText(label, x, y);
            }
        });
    }

    function drawHoveredDragons(ctx: CanvasRenderingContext2D, map: CurrentMap) {
        const hovered = new Set(editorUi.hoveredDragons);
        if (hovered.size === 0) return;
        const dragons = map.staticMap.initialDragons.filter((dragon) => hovered.has(dragon.id));
        if (dragons.length === 0) return;

        ctx.save();
        const sc = { cell: cellSize, time: 0, portals: map.portals, board: map, suppressTorusDuplicates: true };
        for (const view of settledDragonViews(new Bodies(dragons), cellSize, map.portals, map)) {
            resolveDragonSkin(dragonSkin, view.team).drawDragon(ctx, { ...view, alpha: 1 }, sc);
        }
        ctx.fillStyle = HOVER_WASH;
        for (const dragon of dragons) {
            for (const cell of dragon.body) ctx.fillRect(cell.x * cellSize, cell.y * cellSize, cellSize, cellSize);
        }
        ctx.restore();
    }

    function drawDragonDraft(ctx: CanvasRenderingContext2D) {
        const team = editor.nextDragonTeam;
        const mirrorTeam: 0 | 1 = team === 0 ? 1 : 0;
        editor.dragonDraft.forEach(([x, y], index) => {
            ctx.fillStyle = draftColor(team, index === 0 ? 0.85 : 0.45);
            ctx.fillRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
            const [mx, my] = mirrorTile(x, y);
            ctx.fillStyle = draftColor(mirrorTeam, index === 0 ? 0.6 : 0.3);
            ctx.fillRect(mx * cellSize + 1, my * cellSize + 1, cellSize - 2, cellSize - 2);
        });
    }

    /**
     * The portal end waiting for its partner.
     */
    function drawPendingPortal(ctx: CanvasRenderingContext2D) {
        if (!editor.pendingPortal) return;
        const [px, py] = editor.pendingPortal;
        for (const [x, y] of mirroredEdges(px, py)) {
            const edge = toBoardEdge(x, y);
            edgeBar(ctx, edge, cellSize, GHOST_PORTAL);
        }
    }

    /**
     * The dragons the map spawns, drawn with the real skins so shape and facing
     * read as they will in a replay. The caller sets `alpha`; they are held back
     * by default as an indicator of where the file puts them, not part of the
     * board.
     */
    function drawSpawnDragons(ctx: CanvasRenderingContext2D, map: CurrentMap, sc: SkinContext, alpha = 0.6) {
        const bodies = new Bodies(map.staticMap.initialDragons);
        for (const view of settledDragonViews(bodies, cellSize, map.portals, map)) {
            // Through the view, not ctx.globalAlpha: sprite skins assign
            // globalAlpha from `alpha` themselves, overwriting the caller's.
            resolveDragonSkin(dragonSkin, view.team).drawDragon(ctx, { ...view, alpha }, sc);
        }
    }

    /**
     * The bottom and right boundaries, drawn as the viewer draws them: a dotted
     * seam marking a continuation of the board rather than a wall. Nothing else
     * is drawn there, since those boundaries are the top and left ones again.
     */
    function drawSeams(ctx: CanvasRenderingContext2D) {
        const w = editor.w * cellSize;
        const h = editor.h * cellSize;
        ctx.save();
        ctx.strokeStyle = "rgba(190, 220, 230, 0.34)";
        ctx.lineWidth = Math.max(1, cellSize * 0.035);
        ctx.setLineDash([Math.max(2, cellSize * 0.13), Math.max(3, cellSize * 0.16)]);
        const inset = ctx.lineWidth;
        ctx.beginPath();
        ctx.moveTo(0, h - inset);
        ctx.lineTo(w, h - inset);
        ctx.moveTo(w - inset, 0);
        ctx.lineTo(w - inset, h);
        ctx.stroke();
        ctx.restore();
    }

    /** Centre of a boundary, in board pixels. */
    function edgeMidpoint(edge: Edge): { x: number; y: number } {
        return {
            x: (edge.x + (edge.side === "W" ? 0 : 0.5)) * cellSize,
            y: (edge.y + (edge.side === "N" ? 0 : 0.5)) * cellSize,
        };
    }

    function portalLabelSize(): number {
        return Math.max(8, Math.round(cellSize * 0.3));
    }

    /**
     * Where a portal's label sits, and its connector line ends.
     */
    function labelPoint(edge: Edge): { x: number; y: number } {
        const { x, y } = edgeMidpoint(edge);
        const margin = portalLabelSize() * 0.75;
        return {
            x: clamp(x, margin, editor.w * cellSize - margin),
            y: clamp(y, margin, editor.h * cellSize - margin),
        };
    }

    /**
     * Each portal pair joined by a right angle in the pair's own tint, so which
     * two boundaries lead to each other is readable without counting labels.
     */
    function drawPortalLinks(ctx: CanvasRenderingContext2D, map: StaticMap) {
        const spread = cellSize * 0.16;
        const dash = Math.max(3, cellSize * 0.28);
        ctx.lineWidth = Math.max(1, cellSize * 0.07);
        ctx.lineJoin = "round";
        ctx.lineCap = "butt";
        map.portals.forEach(([a, b], index) => {
            // Knocked off the shared line by an offset of its own, so co-linear
            // connectors sit beside each other rather than stacked.
            const dx = (scatter(a, b, 1) - 0.5) * spread;
            const dy = (scatter(a, b, 2) - 0.5) * spread;
            // From label to label, so a line between two border portals runs
            // just inside the board instead of along the clipped canvas edge.
            const from = labelPoint(a);
            const to = labelPoint(b);
            const label = map.portalLabels[index];
            ctx.strokeStyle = mapSkin.portalColor?.(label) ?? portalPairColor(label);
            // Dashed out of step with its neighbours, so two that still land on
            // the same line show through each other's gaps instead of one
            // hiding the other.
            ctx.setLineDash([dash, dash]);
            ctx.lineDashOffset = scatter(a, b, 3) * 2 * dash;
            ctx.beginPath();
            ctx.moveTo(from.x + dx, from.y + dy);
            // Across, then down: two axis-aligned runs meeting at one corner.
            ctx.lineTo(to.x + dx, from.y + dy);
            ctx.lineTo(to.x + dx, to.y + dy);
            ctx.stroke();
        });
        // Labels stroke their outline next, and would inherit the dash.
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
    }

    /** A settled number in [0, 1) for one portal pair, from its own coordinates. */
    function scatter(a: Edge, b: Edge, salt: number): number {
        let hash = 2166136261 ^ salt;
        for (const n of [a.x, a.y, a.side === "N" ? 0 : 1, b.x, b.y, b.side === "N" ? 0 : 1]) {
            hash = Math.imul(hash ^ (n + 0x9e3779b9), 16777619);
        }
        return ((hash >>> 0) % 4096) / 4096;
    }

    /** Compact round counts so a whole range still fits a tile: 950, 1.2k, 12k. */
    function shortRounds(n: number): string {
        if (n < 1000) return String(n);
        const thousands = n / 1000;
        return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
    }

    /**
     * The round range each tile waits between pearl spawn attempts. Tiles that
     * never spawn are left blank rather than shown as a range, so a sparse board
     * reads as mostly empty.
     */
    function drawPearlNumbers(ctx: CanvasRenderingContext2D, map: StaticMap) {
        const labels = map.pearlRespawn.map((bounds) =>
            bounds.maxRounds > 0 ? [shortRounds(bounds.maxRounds), shortRounds(bounds.minRounds)] : undefined,
        );
        const widest = labels
            .flat()
            .reduce<string | undefined>((a, b) => (b && b.length > (a?.length ?? 0) ? b : a), undefined);
        if (!widest) return;

        // Keep a uniform size fitted to the longest label. Fractional sizes
        // let the text scale with zoom instead of disappearing below a cutoff.
        const base = cellSize * 0.42;
        ctx.font = `${base}px ui-monospace, monospace`;
        const widestWidth = ctx.measureText(widest).width;
        const room = cellSize * 0.88;
        const size = Math.max(1, widestWidth > room ? base * (room / widestWidth) : base);

        ctx.font = `${size}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(0.35, size * 0.14);
        ctx.strokeStyle = "rgba(6, 12, 24, 0.85)";
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                const bounds = labels[y * map.width + x];
                if (!bounds) continue;
                const cx = (x + 0.5) * cellSize;
                const cy = (y + 0.5) * cellSize;
                // Outlined so the range stays legible over any floor sprite.
                ctx.fillStyle = "#f0e2bd";
                bounds.forEach((label, line) => {
                    const lineY = cy + (line - 0.5) * size * 1.05;
                    ctx.strokeText(label, cx, lineY, room);
                    ctx.fillText(label, cx, lineY, room);
                });
            }
        }
    }

    function drawGhost(ctx: CanvasRenderingContext2D) {
        if (!hover) return;
        const color = hoverIssue
            ? GHOST_INVALID
            : editor.brushType === "portal"
              ? GHOST_PORTAL
              : brushValue(hoverMods)
                ? GHOST_KELP
                : GHOST_ERASE;

        // A tile brush washes the cell too, so which tile is under the cursor
        // stays obvious even when all four sides are already drawn.
        if (hover.kind === "tile") {
            ctx.fillStyle = hoverIssue ? "rgba(255, 96, 84, 0.16)" : "rgba(255, 255, 255, 0.09)";
            ctx.fillRect(hover.x * cellSize, hover.y * cellSize, cellSize, cellSize);
        }
        for (const [x, y] of affectedEdges(hover)) {
            const edge = toBoardEdge(x, y);
            edgeBar(ctx, edge, cellSize, color);
        }
    }

    /**
     * The boundary the pointer is over, or undefined where no single one wins.
     */
    function edgeAt(localX: number, localY: number): Target | undefined {
        const cellX = Math.floor(localX / cellSize);
        const cellY = Math.floor(localY / cellSize);
        const fx = localX / cellSize - cellX;
        const fy = localY / cellSize - cellY;
        /** How far into the tile a side reaches. */
        const DEPTH = 0.32;
        /** Dead margin at each end of a side, so neighbours can't overlap. */
        const CORNER = 0.25;

        const alongSide = (t: number) => t > CORNER && t < 1 - CORNER;
        let target: Target | undefined;
        if (fy < DEPTH && alongSide(fx)) target = { kind: "edge", x: cellX, y: cellY * 2 };
        else if (1 - fy < DEPTH && alongSide(fx)) target = { kind: "edge", x: cellX, y: cellY * 2 + 2 };
        else if (fx < DEPTH && alongSide(fy)) target = { kind: "edge", x: cellX, y: cellY * 2 + 1 };
        else if (1 - fx < DEPTH && alongSide(fy)) target = { kind: "edge", x: cellX + 1, y: cellY * 2 + 1 };
        if (target && !edgeInRange(target.x, target.y)) return undefined;
        return target;
    }

    function modsOf(e: MouseEvent): Modifiers {
        const right = (e.buttons & 2) !== 0 || (e.type === "pointerdown" && e.button === 2);
        return { ctrl: e.ctrlKey || right, shift: e.shiftKey && !right };
    }

    /** The target under the pointer, or undefined when it's off the board. */
    function targetAt(e: MouseEvent, mods: Modifiers): Target | undefined {
        if (!canvas) return undefined;
        const rect = canvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        if (localX < 0 || localY < 0 || localX >= rect.width || localY >= rect.height) return undefined;
        const tile: Target = {
            kind: "tile",
            x: Math.floor(localX / cellSize),
            y: Math.floor(localY / cellSize),
        };
        // Erasing aims at the same thing the brush draws, so right-clicking in
        // dragon mode never lands on a boundary. On `all` no layer pins the
        // brush, so an erase away from a boundary takes the cell instead of
        // finding nothing at all.
        if (selection.tool === "select" || editor.brushType === "pearl" || editor.brushType === "dragon") return tile;
        if (!brushValue(mods) && editor.layer === "all") return edgeAt(localX, localY) ?? tile;
        return edgeAt(localX, localY);
    }

    let drawing = false;
    onDestroy(() => {
        if (drawing) cancelEdit();
    });
    function handlePointerDown(e: PointerEvent) {
        if (!e.isPrimary || (e.button !== 0 && e.button !== 2)) return;
        canvas?.focus({ preventScroll: true });
        canvas?.setPointerCapture(e.pointerId);
        // Painting is a drag, and so is the selection the browser would otherwise
        // start here. That one auto-scrolls the stage as the pointer nears its
        // edge, which on a board bigger than the stage walks the map off screen.
        e.preventDefault();
        const mods = modsOf(e);
        const target = targetAt(e, mods);
        if (selection.tool === "select") {
            if (e.button !== 0 || !target) return;
            if (selection.pasting) {
                placeSelection(target.x, target.y, true);
                return;
            }
            const start: [number, number] = [target.x, target.y];
            const initial = selection.rectangle ? { ...selection.rectangle } : undefined;
            const moving = initial && contains(initial, ...start);
            gesture = { kind: moving ? "move" : "select", start, current: start, initial };
            if (!moving) selection.rectangle = undefined;
            selection.message = "";
            return;
        }
        drawing = true;
        beginEdit();
        if (target) paint(target, mods);
    }

    function handlePointerMove(e: PointerEvent) {
        if (!e.isPrimary) return;
        hoverMods = modsOf(e);
        hover = targetAt(e, hoverMods);
        if (gesture && hover) {
            gesture.current = [hover.x, hover.y];
            if (gesture.kind === "select") {
                const dragged = hover.x !== gesture.start[0] || hover.y !== gesture.start[1];
                selection.rectangle = dragged ? rectangleBetween(gesture.start, gesture.current) : undefined;
            }
            return;
        }
        // Dragging with either button keeps going: left paints, right erases.
        if (drawing && hover && e.buttons & 3) paint(hover, hoverMods);
    }

    // Ctrl or meta held means the browser's own page zoom; leave that alone.
    function handleWheel(e: WheelEvent) {
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 1, 64 / Math.max(1, fittedCell));
    }

    // Dragon drawing is drag and release. Only the left button draws, so letting
    // go of a right-click erase mid-drag doesn't commit a half-drawn dragon.
    function handlePointerUp(e: PointerEvent) {
        if (gesture && e.isPrimary) {
            if (gesture.kind === "move")
                placeSelection(gesture.current[0] - gesture.start[0], gesture.current[1] - gesture.start[1]);
            gesture = undefined;
            return;
        }
        if (!drawing || !e.isPrimary) return;
        drawing = false;
        if (e.button === 0 && editor.brushType === "dragon" && editor.dragonDraft.length) {
            if (editor.dragonDraft.length < 2) cancelDragonDraft();
            else commitDragonDraft();
        }
        endEdit();
    }

    let keyboardX = 0;
    let keyboardY = 0;
    let verticalEdge = false;
    let keyboardStatus = $state("");
    function keyboardTarget() {
        keyboardX = clamp(keyboardX, 0, editor.w - 1);
        keyboardY = clamp(keyboardY, 0, editor.h - 1);
        const tile = selection.tool === "select" || editor.brushType === "pearl" || editor.brushType === "dragon";
        hover = tile
            ? { kind: "tile", x: keyboardX, y: keyboardY }
            : { kind: "edge", x: keyboardX, y: keyboardY * 2 + (verticalEdge ? 1 : 0) };
        keyboardStatus = `Column ${keyboardX + 1}, row ${keyboardY + 1}, ${tile ? "tile" : verticalEdge ? "left edge" : "top edge"}.`;
    }
    function handleKeyboard(e: KeyboardEvent) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (selection.tool === "select") {
            if (e.key.startsWith("Arrow")) {
                e.preventDefault();
                if (e.shiftKey && selection.rectangle && !selection.pasting) {
                    const rect = selection.rectangle;
                    const x = clamp(
                        rect.x + rect.width - 1 + (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0),
                        rect.x,
                        editor.w - 1,
                    );
                    const y = clamp(
                        rect.y + rect.height - 1 + (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0),
                        rect.y,
                        editor.h - 1,
                    );
                    selection.rectangle = rectangleBetween([rect.x, rect.y], [x, y]);
                } else if (selection.rectangle && !selection.pasting) {
                    placeSelection(
                        e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0,
                        e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0,
                    );
                } else {
                    keyboardX += e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                    keyboardY += e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
                    keyboardTarget();
                }
            } else if (e.key === "Enter" && selection.pasting) {
                e.preventDefault();
                placeSelection(keyboardX, keyboardY, true);
            } else if (e.key === "Escape") {
                gesture = undefined;
                clearSelection();
            }
            return;
        }
        if (
            ![
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                " ",
                "Enter",
                "Delete",
                "Backspace",
                "Escape",
                "e",
                "E",
            ].includes(e.key)
        )
            return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowLeft") keyboardX--;
        if (e.key === "ArrowRight") keyboardX++;
        if (e.key === "ArrowUp") keyboardY--;
        if (e.key === "ArrowDown") keyboardY++;
        if (e.key.toLowerCase() === "e") verticalEdge = !verticalEdge;
        hoverMods = { ctrl: e.key === "Delete" || e.key === "Backspace", shift: e.shiftKey };
        keyboardTarget();
        if ([" ", "Delete", "Backspace"].includes(e.key) && hover) {
            const issue = placementIssue(hover, hoverMods);
            edit(() => paint(hover!, hoverMods));
            keyboardStatus += issue ? ` ${issue}` : " Applied.";
        }
        if (e.key === "Enter") keyboardStatus += edit(commitDragonDraft) ?? " Dragon finished.";
        if (e.key === "Escape") {
            cancelDragonDraft();
            editor.pendingPortal = undefined;
            if (drawing) {
                drawing = false;
                cancelEdit();
            }
            keyboardStatus += " Drawing cancelled.";
        }
    }
</script>

<svelte:window onpointerup={handlePointerUp} />

<div
    class="stage"
    bind:this={canvasWrapper}
    role="presentation"
    onpointerleave={() => (hover = undefined)}
    onwheel={handleWheel}
    oncontextmenu={(e) => e.preventDefault()}
>
    {#if error}
        <div class="preview-error">{error}</div>
    {/if}
    {#if hoverIssue && !error}
        <div class="hover-issue">{hoverIssue}</div>
    {/if}
    <!-- The whole stage swallows the context menu, not just the canvas: a
             right-drag erase that ends just off the board would open it. -->
    <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role (This keyboard-operated drawing surface manages its own commands.) -->
    <canvas
        bind:this={canvas}
        tabindex="0"
        role="application"
        aria-label="Map drawing canvas. Draw: arrows move, Space paints, E changes edge, Delete erases, Enter finishes a dragon. Select: Shift+arrows resize, arrows move the selection, Enter pastes. Escape cancels."
        onfocus={keyboardTarget}
        onkeydown={handleKeyboard}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointercancel={() => {
            drawing = false;
            cancelDragonDraft();
            cancelEdit();
            if (gesture) selection.rectangle = gesture.initial;
            gesture = undefined;
        }}
    ></canvas>
    <span class="keyboard-status" role="status">{keyboardStatus}</span>
</div>

<style>
    .stage {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        align-items: safe center;
        justify-content: safe center;
        padding: 16px;
        overflow: auto;
        position: relative;
    }

    canvas {
        touch-action: none;
        cursor: crosshair;
        image-rendering: pixelated;
        user-select: none;
    }
    .keyboard-status {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }

    .preview-error,
    .hover-issue {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        max-width: calc(100% - 32px);
        padding: 8px 14px;
        font-size: var(--vis-text-meta);
        color: var(--vis-error);
        background: var(--vis-base-200);
        border: 1px solid var(--vis-error);
        border-radius: var(--vis-radius-box);
        z-index: 1;
        pointer-events: none;
    }

    .preview-error {
        top: 16px;
    }

    .hover-issue {
        bottom: 16px;
    }
</style>
