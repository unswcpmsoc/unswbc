<!--
	A pinned entity's panel: one bar carrying the grip, the title and the close
	button, then the rows. Unlike the hover tooltip this takes the pointer, so
	hovering it drops whatever is under it on the board.
-->
<script lang="ts">
    import EntityPanel from "./EntityPanel.svelte";
    import { X } from "@lucide/svelte";
    import type { EntityDescription } from "./describeEntity";

    let {
        description,
        x,
        y,
        onmove,
        onclose,
        onenter,
        onleave,
        following,
        onfollow,
    }: {
        description: EntityDescription;
        x: number;
        y: number;
        onmove: (x: number, y: number) => void;
        onclose: () => void;
        /** The dialogue counts as part of its entity's hitbox, so it reports hover. */
        onenter?: () => void;
        onleave?: () => void;
        /** Dragons only: whether the camera is following it, and the toggle. */
        following?: boolean;
        onfollow?: () => void;
    } = $props();

    let dragging = $state(false);
    let grabX = 0;
    let grabY = 0;

    function handleGrab(e: PointerEvent) {
        if (e.button !== 0) return;
        // Capturing the pointer for a drag would swallow the close button's
        // click, so a press that starts on a control is not a drag.
        if ((e.target as HTMLElement).closest("button")) return;
        dragging = true;
        grabX = e.clientX - x;
        grabY = e.clientY - y;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function handleDrag(e: PointerEvent) {
        if (!dragging) return;
        onmove(e.clientX - grabX, e.clientY - grabY);
    }

    function handleRelease(e: PointerEvent) {
        if (!dragging) return;
        dragging = false;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
</script>

<div
    class="window"
    style:left="{x}px"
    style:top="{y}px"
    role="presentation"
    onpointerenter={() => onenter?.()}
    onpointerleave={() => onleave?.()}
>
    <div
        class="bar"
        class:dragging
        role="presentation"
        onpointerdown={handleGrab}
        onpointermove={handleDrag}
        onpointerup={handleRelease}
        onpointercancel={handleRelease}
    >
        <span class="grip" aria-hidden="true"></span>
        <span class="title">{description.title}</span>
        {#if onfollow}
            <button class="follow" class:on={following} onclick={onfollow} aria-pressed={following}
                >{following ? "Following" : "Follow"}</button
            >
        {/if}
        <button class="close" onclick={onclose} aria-label="Close {description.title}"
            ><X size={14} strokeWidth={2} /></button
        >
    </div>
    <div class="body">
        <EntityPanel {description} title={false} />
    </div>
</div>

<style>
    .window {
        position: absolute;
        pointer-events: auto;
        min-width: 132px;
        background: var(--vis-base-200);
        border: 1px solid var(--vis-ink-3);
    }

    .bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 3px 3px 5px;
        background: var(--vis-press);
        border-bottom: 1px solid var(--vis-rule);
        cursor: grab;
        touch-action: none;
    }

    .bar.dragging {
        cursor: grabbing;
    }

    /* Two columns of three dots: the usual "this moves" affordance. */
    .grip {
        width: 6px;
        height: 10px;
        flex-shrink: 0;
        background-image: radial-gradient(var(--vis-ink-3) 40%, transparent 42%);
        background-size: 3px 3.4px;
    }

    .title {
        flex: 1;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink);
        white-space: nowrap;
    }

    .close {
        display: grid;
        place-items: center;
        width: calc(1.25rem * var(--font-scale, 1));
        height: calc(1.25rem * var(--font-scale, 1));
        color: var(--vis-ink-3);
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
    }

    .close:hover {
        color: var(--vis-ink);
    }

    .follow {
        font-family: inherit;
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink-2);
        background: var(--vis-base-200);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        padding: 0 5px;
        cursor: pointer;
    }

    .follow:hover,
    .follow.on {
        color: var(--vis-ink);
        border-color: var(--vis-ink-3);
    }

    .body {
        padding: 5px 8px 6px;
    }
</style>
