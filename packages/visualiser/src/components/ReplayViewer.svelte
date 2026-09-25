<!--
    The board and its controls, with no chrome around them: BoardStage brings
    the hover tooltip and the pinnable entity windows, PlaybackControls sits
    under it.

    The class names carry a `viewer-` prefix on purpose. Plain `dock` is a
    daisyUI component — a bar fixed to the bottom of the window — and naming a
    div after one silently adopts it.

    The controls follow the host theme; the board draws its own sea palette
    in both.
-->
<script lang="ts">
    import BoardStage from "../visualiser/BoardStage.svelte";
    import GameRunner from "../visualiser/GameRunner.svelte";
    import PlaybackControls from "../visualiser/PlaybackControls.svelte";
    import { X } from "@lucide/svelte";
    import { mapSkins, teamDragonSkins } from "../skins/index";
    import { settings } from "../settings.svelte";
    import type { LoadedReplay } from "../replay/loader";
    import { downloadFile } from "../replay/browserFiles";

    let {
        loaded,
        runner: providedRunner,
        maxCell = 160,
        fill = false,
        name = "replay",
    }: {
        loaded: LoadedReplay;
        /** Share a runner across renders (the /visualiser tab does, to survive navigation). */
        runner?: GameRunner;
        maxCell?: number;
        /** Take height from the parent. Off, the board's own shape sets it. */
        fill?: boolean;
        /** Base for a saved image's file name. */
        name?: string;
    } = $props();

    let root: HTMLDivElement | undefined = $state();

    // Full board: the board and controls over the whole window. Not the
    // browser's fullscreen, which the VS Code viewer can't use.
    let fullBoard = $state(false);
    let helpOpen = $state(false);

    function snapshot() {
        root?.querySelector<HTMLCanvasElement>(".board-view > canvas")?.toBlob((blob) => {
            if (!blob) return;
            const round = String(runner.round).padStart(3, "0");
            downloadFile(blob, `${name.replace(/\.replay$/, "")}-round-${round}.png`);
        });
    }

    function exitOnEscape(e: KeyboardEvent) {
        if (e.key !== "Escape") return;
        if (helpOpen) helpOpen = false;
        else if (fullBoard) fullBoard = false;
    }

    const SHORTCUTS: [string, string][] = [
        ["Space", "Play or pause"],
        ["← →", "Step back or forward"],
        ["Shift ← →", "Step ten at a time"],
        ["Home End", "Jump to the start or end"],
        ["− +", "Half or double speed"],
        ["F", "Full board"],
        ["Esc", "Reset the view, or leave full board"],
        ["Drag, scroll", "Pan and zoom the board"],
        ["Click", "Pin a dragon, tile or portal"],
        ["?", "Show these shortcuts"],
    ];

    const runner = $derived(providedRunner ?? new GameRunner(loaded.match));
    const board = $derived(loaded.match.roundAt(0).map);

    const mapSkin = $derived(mapSkins.get(settings.mapSkinName));
    // A battle from the site pins the skins its teams played in; anything else
    // follows the viewer's own choice.
    const dragonSkin = $derived(
        teamDragonSkins.getBothTeamSkins(
            loaded.teams.A.skin ?? settings.teamASkinName,
            loaded.teams.B.skin ?? settings.teamBSkinName,
        ),
    );
</script>

<svelte:window onkeydown={exitOnEscape} />

<div class="replay-viewer" class:fill class:full={fullBoard} bind:this={root}>
    <div class="viewer-stage" style:aspect-ratio={fill ? null : `${board.width} / ${board.height}`}>
        <BoardStage match={loaded.match} {runner} {mapSkin} {dragonSkin} {maxCell} class="board" />
    </div>
    <div class="viewer-dock">
        <PlaybackControls
            {runner}
            match={loaded.match}
            class="viewer-controls"
            onfullboard={() => (fullBoard = !fullBoard)}
            onsnapshot={snapshot}
            onhelp={() => (helpOpen = !helpOpen)}
        />
    </div>
    {#if helpOpen}
        <div class="help" role="dialog" aria-label="Keyboard shortcuts">
            <div class="help-head">
                <span>Keyboard shortcuts</span>
                <button onclick={() => (helpOpen = false)} aria-label="Close"><X size={14} strokeWidth={2} /></button>
            </div>
            <dl>
                {#each SHORTCUTS as [keys, action] (keys)}
                    <dt>{keys}</dt>
                    <dd>{action}</dd>
                {/each}
            </dl>
        </div>
    {/if}
</div>

<style>
    .replay-viewer {
        position: relative;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--vis-base-200);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
    }

    /* In a flex column parent; `height: 100%` would resolve against a parent
       whose own height is still auto on the battles page. */
    .replay-viewer.fill {
        flex: 1;
        min-height: 0;
    }

    /* Two ways to get a height. With `fill` the parent is definite and the
       stage takes what the controls leave. Without it the inline aspect-ratio
       supplies one: `flex: 1` is no obstacle, because a percentage basis
       against an indefinite height resolves to auto and falls back to the
       content size. */
    .viewer-stage {
        flex: 1;
        min-height: 0;
        display: flex;
        padding: 0.75rem;
    }

    .replay-viewer.full {
        position: fixed;
        inset: 0;
        /* Over the site's own navigation, which sits at 100. */
        z-index: 200;
        border: 0;
        border-radius: 0;
    }

    .help {
        position: absolute;
        top: 1rem;
        right: 1rem;
        z-index: 10;
        width: min(20rem, calc(100% - 2rem));
        background: var(--vis-base-200);
        border: 1px solid var(--vis-ink-3);
    }

    .help-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 6px 4px 10px;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink);
        background: var(--vis-press);
        border-bottom: 1px solid var(--vis-rule);
    }

    .help-head button {
        display: grid;
        place-items: center;
        width: calc(1.25rem * var(--font-scale, 1));
        height: calc(1.25rem * var(--font-scale, 1));
        color: var(--vis-ink-3);
        background: none;
        border: 0;
        padding: 0;
        cursor: pointer;
    }

    .help dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0;
        padding: 8px 10px 10px;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
    }

    .help dt {
        font-weight: 600;
        color: var(--vis-ink);
        white-space: nowrap;
    }

    .help dd {
        margin: 0;
        color: var(--vis-ink-2);
    }

    .viewer-dock {
        flex: 0 0 auto;
        background: var(--vis-base-200);
        border-top: 1px solid var(--vis-rule);
    }

    .viewer-dock :global(.viewer-controls) {
        padding: 0.6rem 0.75rem;
    }
</style>
