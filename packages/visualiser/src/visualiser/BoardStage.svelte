<!--
	The board plus its entity layer. Hover makes an entity salient, clicking
	pins it to a draggable window, and the two are independent: closing a
	window drops an entity back to salient if the cursor is still on it.
-->
<script lang="ts">
    import BoardView from "./BoardView.svelte";
    import EntityPanel from "./EntityPanel.svelte";
    import EntityWindow from "./EntityWindow.svelte";
    import { PearlClock } from "./PearlClock";
    import { DragonAges } from "./DragonAges";
    import { describeEntity } from "./describeEntity";
    import { dragonEntityId, type Entity } from "./Entities";
    import type GameRunner from "./GameRunner.svelte";
    import type Match from "./Match";
    import type { MapSkin, DragonSkin } from "./Skins";
    import { settings } from "../settings.svelte";

    let {
        match,
        runner,
        mapSkin,
        dragonSkin,
        minCell = 6,
        maxCell = 44,
        class: className = "",
    }: {
        match: Match;
        runner?: GameRunner;
        mapSkin: MapSkin;
        dragonSkin: DragonSkin;
        minCell?: number;
        maxCell?: number;
        class?: string;
    } = $props();

    interface PinnedEntity {
        entity: Entity;
        x: number;
        y: number;
    }

    /** Hover has two sources: the entity's own hitbox, and its pinned dialogue. */
    let boardHover: Entity | undefined = $state();
    let windowHoverId: string | undefined = $state();
    let cursor = $state({ x: 0, y: 0 });
    let pinned = $state<PinnedEntity[]>([]);
    let tooltipElement: HTMLDivElement | undefined = $state();
    let tooltipSize = $state({ width: 220, height: 120 });

    $effect(() => {
        boardHover;
        if (!tooltipElement) return;
        const width = tooltipElement.offsetWidth;
        const height = tooltipElement.offsetHeight;
        if (width !== tooltipSize.width || height !== tooltipSize.height) {
            tooltipSize = { width, height };
        }
    });

    /**
     * A pinned window hover temporarily isolates its entity on the board. Away
     * from windows, pins remain visible and board hover adds one annotation.
     */
    const salient = $derived.by(() => {
        if (windowHoverId) {
            const isolated = pinned.find((pin) => pin.entity.id === windowHoverId);
            return isolated ? [isolated.entity] : [];
        }
        const entities = pinned.map((pin) => pin.entity);
        if (boardHover && !entities.some((entity) => entity.id === boardHover?.id)) entities.push(boardHover);
        return entities;
    });
    // Debug drawings and status indicators follow the same visible selection as
    // the head/vision outlines: transient board hover counts, and hovering one
    // pinned window temporarily isolates that dragon.
    const debugDragonIds = $derived(
        salient.flatMap((entity) => (entity.kind === "dragon" ? [entity.dragonId] : [])),
    );

    const pearlClock = $derived(new PearlClock(match));
    const dragonAges = $derived(new DragonAges(match));
    const round = $derived(runner ? runner.round : 0);

    function describe(entity: Entity) {
        return describeEntity(entity, {
            frame: match.frameAt(runner?.position ?? 0, runner?.granularity, runner?.stagger),
            map: match.roundAt(round).map,
            round,
            pearlClock,
            dragonAges,
        });
    }

    function handleHover(entity: Entity | undefined, at: { x: number; y: number }) {
        boardHover = entity;
        cursor = at;
    }

    function handlePick(entity: Entity, at: { x: number; y: number }) {
        const existing = pinned.findIndex((pin) => pin.entity.id === entity.id);
        if (existing !== -1) {
            closePin(entity.id);
            return;
        }
        const hovered = boardHover?.id === entity.id && lastTip;
        pinned.push({ entity, x: hovered ? lastTip!.x : at.x + 18, y: hovered ? lastTip!.y : at.y + 18 });
        // The game log follows every pinned dragon, not just the most recent one.
        if (entity.kind === "dragon" && runner && !runner.selectedDragonIds.includes(entity.dragonId)) {
            runner.selectedDragonIds = [...runner.selectedDragonIds, entity.dragonId];
        }
    }

    const closePin = (id: string) => {
        const going = pinned.find((pin) => pin.entity.id === id);
        const closingDragonId = going?.entity.kind === "dragon" ? going.entity.dragonId : undefined;
        pinned = pinned.filter((pin) => pin.entity.id !== id);
        if (windowHoverId === id) windowHoverId = undefined;
        if (closingDragonId !== undefined && runner) {
            runner.selectedDragonIds = runner.selectedDragonIds.filter((dragonId) => dragonId !== closingDragonId);
            if (runner.followDragonId === closingDragonId) runner.followDragonId = undefined;
        }
    };

    // Selected dragons and pinned dragons are one set: a dragon selected from
    // elsewhere (a shared link, say) gets a window, and one dropped from the
    // log's filter loses it.
    $effect(() => {
        if (!runner) return;
        const selected = runner.selectedDragonIds;
        const isPinned = (dragonId: number) =>
            pinned.some((pin) => pin.entity.kind === "dragon" && pin.entity.dragonId === dragonId);
        const stale = pinned.filter(
            (pin) => pin.entity.kind === "dragon" && !selected.includes(pin.entity.dragonId),
        );
        for (const pin of stale) closePin(pin.entity.id);
        selected.forEach((dragonId, k) => {
            if (isPinned(dragonId)) return;
            pinned.push({ entity: { kind: "dragon", id: dragonEntityId(dragonId), dragonId }, x: 16, y: 16 + k * 36 });
        });
    });

    function closeAll() {
        pinned = [];
        windowHoverId = undefined;
        if (runner) {
            runner.selectedDragonIds = [];
            runner.followDragonId = undefined;
        }
    }

    function toggleFollow(dragonId: number) {
        if (!runner) return;
        runner.followDragonId = runner.followDragonId === dragonId ? undefined : dragonId;
    }

    const movePin = (id: string, x: number, y: number) => {
        const pin = pinned.find((p) => p.entity.id === id);
        if (pin) {
            pin.x = x;
            pin.y = y;
        }
    };

    // Where the tooltip was last drawn, so a click pins its window in the
    // same place rather than making it jump.
    let lastTip: { x: number; y: number } | undefined;

    /** Beside the cursor, flipped to the other side near the viewport's edges. */
    function tooltipPosition(view: { width: number; height: number }) {
        const offset = 18;
        const { width, height } = tooltipSize;
        const flipX = cursor.x + offset + width > view.width;
        const flipY = cursor.y + offset + height > view.height;
        lastTip = {
            x: flipX ? Math.max(0, cursor.x - offset - width) : cursor.x + offset,
            y: flipY ? Math.max(0, cursor.y - offset - height) : cursor.y + offset,
        };
        return lastTip;
    }
</script>

<BoardView
    {match}
    {runner}
    {mapSkin}
    {dragonSkin}
    {minCell}
    {maxCell}
    {salient}
    {debugDragonIds}
    showAllIndicators={settings.showAllIndicators}
    onhover={handleHover}
    onpick={handlePick}
    class={className}
>
    {#snippet overlay(projection)}
        {#if boardHover && !pinned.some((pin) => pin.entity.id === boardHover?.id)}
            {@const at = tooltipPosition(projection.viewport)}
            <div bind:this={tooltipElement} class="entity-tip" style:left="{at.x}px" style:top="{at.y}px">
                <EntityPanel description={describe(boardHover)} />
            </div>
        {/if}

        {#if pinned.length > 1}
            <button class="close-all" onclick={closeAll}>Close all ({pinned.length})</button>
        {/if}

        {#each pinned as pin (pin.entity.id)}
            {@const dragonId = pin.entity.kind === "dragon" ? pin.entity.dragonId : undefined}
            <EntityWindow
                description={describe(pin.entity)}
                x={pin.x}
                y={pin.y}
                onmove={(x, y) => movePin(pin.entity.id, x, y)}
                onclose={() => closePin(pin.entity.id)}
                following={dragonId !== undefined && runner?.followDragonId === dragonId}
                onfollow={dragonId !== undefined && runner ? () => toggleFollow(dragonId) : undefined}
                onenter={() => {
                    boardHover = undefined;
                    windowHoverId = pin.entity.id;
                }}
                onleave={() => {
                    if (windowHoverId === pin.entity.id) windowHoverId = undefined;
                }}
            />
        {/each}
    {/snippet}
</BoardView>

<style>
    /* Top right of the board, clear of where new windows open (top left). */
    .close-all {
        position: absolute;
        top: 8px;
        right: 8px;
        pointer-events: auto;
        padding: 3px 8px;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink);
        background: var(--vis-base-200);
        border: 1px solid var(--vis-ink-3);
        border-radius: var(--vis-radius-field);
        cursor: pointer;
    }

    .close-all:hover {
        background: var(--vis-press);
    }

    .entity-tip {
        position: absolute;
        pointer-events: none;
        width: max-content;
        min-width: 10rem;
        max-width: min(21rem, calc(100% - 1rem));
        padding: 5px 8px 6px;
        background: var(--vis-base-200);
        border: 1px solid var(--vis-rule);
    }
</style>
