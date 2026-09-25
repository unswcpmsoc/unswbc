<!--
    A replay with everything about it: the board and controls, beside a
    resizable sidebar of match info, the game log and display options. The
    /visualiser page and the VS Code viewer both use it, so they can't drift.

    It stacks the sidebar under the board by its own width rather than the
    window's, since the two hosts give it very different amounts of room.
    Stacked, it grows past its host's height, so the host has to scroll.
-->
<script lang="ts">
    import GameLog from "./GameLog.svelte";
    import MatchCharts from "./MatchCharts.svelte";
    import ReplayViewer from "./ReplayViewer.svelte";
    import SkinOptions from "./SkinOptions.svelte";
    import TeamStats from "./TeamStats.svelte";
    import { MatchEventStatsTracker, MatchStatsTracker } from "../matchStats";
    import { MARKER_KINDS, persistSettings, settings, teamColor, type MarkerKind } from "../settings.svelte";
    import { resultLabel, type LoadedReplay } from "../replay/loader";
    import type GameRunner from "../visualiser/GameRunner.svelte";

    let {
        loaded,
        runner,
        file,
        mapName,
        hosted = false,
    }: {
        loaded: LoadedReplay;
        runner: GameRunner;
        file: string;
        /** Overrides the MAP_NAME the map carries, when the host knows a better one. */
        mapName?: string;
        /**
         * A competition match rather than a replay file someone opened. The page
         * around it already heads the result, and whose bot version played is
         * not the rest of the ladder's business.
         */
        hosted?: boolean;
    } = $props();

    const TABS = [
        { id: "info", label: "Info" },
        { id: "log", label: "Game Log" },
        { id: "options", label: "Options" },
    ] as const;
    type Tab = (typeof TABS)[number]["id"];
    let tab: Tab = $state("info");

    function cycleTab(e: KeyboardEvent) {
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const at = TABS.findIndex((t) => t.id === tab);
        tab = TABS[(at + step + TABS.length) % TABS.length].id;
        document.getElementById(`tab-${tab}`)?.focus();
    }

    // The drag measures from the row's own left edge, since neither host
    // starts it at the edge of the window.
    let layoutEl: HTMLDivElement | undefined = $state();
    let sidebarWidth = $state(330);
    let resizing = $state(false);
    const clampWidth = (width: number) => Math.max(260, Math.min(width, Math.min(680, window.innerWidth * 0.58)));

    function beginResize(e: PointerEvent) {
        resizing = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function resize(e: PointerEvent) {
        if (!resizing || !layoutEl) return;
        sidebarWidth = clampWidth(e.clientX - layoutEl.getBoundingClientRect().left);
    }

    // One tracker per loaded match; the cache is meaningless across matches.
    const tracker = $derived(new MatchStatsTracker(loaded.match));
    const eventTracker = $derived(new MatchEventStatsTracker(loaded.match));
    // Two-stage derive: `round` re-evaluates every frame, but the per-team
    // scan only re-runs when that floored value changes.
    const round = $derived(runner.round);
    const stats = $derived(tracker.statsAt(round));
    const events = $derived(eventTracker.statsAt(round));
    const board = $derived(loaded.match.roundAt(0).map);

    // Battle replays come from the server with only the viewer's own team's
    // bot output, so choosing between teams only means anything for a local
    // file that still has both.
    const bothTeamsTalk = $derived.by(() => {
        const team = new Map<number, string>();
        for (const dragon of loaded.match.roundAt(0).bodies.dragons.values()) team.set(dragon.id, dragon.team);
        const talking = new Set<string>();
        for (const event of loaded.events) {
            if (event.type === "dragonSplit") team.set(event.childId, event.team);
            else if (event.type === "dragonLog" || event.type === "dragonIndicator" || event.type === "debugDraw") {
                const side = team.get(event.id);
                if (side) talking.add(side);
                if (talking.size === 2) return true;
            }
        }
        return false;
    });

    const MARKER_LABELS: Record<MarkerKind, string> = {
        death: "Deaths",
        split: "Splits",
        engine: "Engine errors",
        bot: "Bot logs",
    };

    function toggleMarker(kind: MarkerKind) {
        settings.markerKinds = settings.markerKinds.includes(kind)
            ? settings.markerKinds.filter((k) => k !== kind)
            : [...settings.markerKinds, kind];
        persistSettings();
    }
</script>

<svelte:window onpointermove={resize} onpointerup={() => (resizing = false)} />

<div class="inspector">
    <div class="layout" class:resizing bind:this={layoutEl}>
        <aside class="side" style:--side-width="{sidebarWidth}px">
            <div class="side-inner">
                <div class="tabs" role="tablist" tabindex="-1" aria-label="Replay detail" onkeydown={cycleTab}>
                    {#each TABS as t (t.id)}
                        <button
                            type="button"
                            role="tab"
                            id="tab-{t.id}"
                            aria-selected={tab === t.id}
                            tabindex={tab === t.id ? 0 : -1}
                            aria-controls="panel-{t.id}"
                            class="tab"
                            class:on={tab === t.id}
                            onclick={() => (tab = t.id)}>{t.label}</button
                        >
                    {/each}
                </div>

                {#if tab === "log"}
                    <div class="panel log" role="tabpanel" tabindex="0" id="panel-log" aria-labelledby="tab-log">
                        <GameLog match={loaded.match} {runner} teams={loaded.teams} />
                    </div>
                {:else if tab === "info"}
                    <div class="panel info" role="tabpanel" tabindex="0" id="panel-info" aria-labelledby="tab-info">
                        {#if mapName || board.staticMap.mapName}
                            <div class="result">
                                <span class="stamp">Map</span>
                                <span class="result-label map">{mapName || board.staticMap.mapName}</span>
                            </div>
                        {/if}

                        {#if !hosted}
                            <div class="result">
                                <span class="stamp">Final result</span>
                                <span
                                    class="result-label"
                                    style:color={loaded.result.winner
                                        ? teamColor(loaded.teams[loaded.result.winner])
                                        : "var(--vis-ink)"}
                                    >{resultLabel(loaded.result, loaded.teams, loaded.match.maxRound)}</span
                                >
                            </div>
                        {/if}

                        <TeamStats teams={loaded.teams} {stats} />

                        <div class="block">
                            <MatchCharts
                                {tracker}
                                {round}
                                colors={{ A: teamColor(loaded.teams.A), B: teamColor(loaded.teams.B) }}
                            />
                        </div>

                        <div class="block">
                            <span class="stamp">Totals through round {round}</span>
                            <TeamStats teams={loaded.teams} {stats} {events} />
                        </div>

                        <div class="block">
                            <span class="stamp">Board</span>
                            <div class="row">
                                <span>Size</span><span class="value">{board.width}×{board.height}</span>
                            </div>
                            <div class="row"><span>Pearls on board</span><span class="value">{stats.pearls}</span></div>
                            <div class="row"><span>Portals</span><span class="value">{board.portals.length}</span></div>
                        </div>
                    </div>
                {:else}
                    <div
                        class="panel options"
                        role="tabpanel"
                        tabindex="0"
                        id="panel-options"
                        aria-labelledby="tab-options"
                    >
                        <section class="opt">
                            <span class="stamp">Timeline markers</span>
                            <div class="picks">
                                {#each MARKER_KINDS as kind (kind)}
                                    <button
                                        class="pick {kind}"
                                        class:on={settings.markerKinds.includes(kind)}
                                        aria-pressed={settings.markerKinds.includes(kind)}
                                        onclick={() => toggleMarker(kind)}>{MARKER_LABELS[kind]}</button
                                    >
                                {/each}
                            </div>
                            <p class="hint">
                                These events get a tick above the timeline, so you can jump to them.{runner.ownTeam
                                    ? " Your team's ticks are brighter."
                                    : ""}
                            </p>
                        </section>

                        {#if bothTeamsTalk}
                            <section class="opt">
                                <span class="stamp">Bot output</span>
                                <div class="picks" role="radiogroup" aria-label="Whose bot output to show">
                                    {#each [undefined, "A", "B"] as const as team (team ?? "both")}
                                        <label class="pick"
                                            ><input
                                                type="radio"
                                                name="output-team"
                                                checked={runner.outputTeam === team}
                                                onchange={() => (runner.outputTeam = team)}
                                            />{#if team}<span
                                                    class="swatch"
                                                    style:background={teamColor(loaded.teams[team])}
                                                ></span>{loaded.teams[team].name}{:else}Both teams{/if}</label
                                        >
                                    {/each}
                                </div>
                                <p class="hint">
                                    Indicators and drawings on the board, and bot and engine lines in the log.
                                </p>
                            </section>
                        {/if}

                        <SkinOptions compact />
                    </div>
                {/if}
            </div>
        </aside>

        <button
            class="resize-handle"
            aria-label="Resize sidebar"
            onpointerdown={beginResize}
            onkeydown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                sidebarWidth = clampWidth(sidebarWidth + (event.key === "ArrowRight" ? 20 : -20));
            }}
        ></button>

        <div class="main">
            <ReplayViewer {loaded} {runner} fill name={file} />
        </div>
    </div>
</div>

<style>
    .inspector {
        container-type: inline-size;
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .layout {
        display: flex;
        flex: 1;
        align-items: stretch;
        gap: 1.25rem;
        min-height: 0;
    }

    .layout.resizing {
        cursor: col-resize;
        user-select: none;
    }

    /* A wide hit area over a hairline, invisible until reached for: the
       sidebar's own border already marks the edge. Negative margin keeps it
       inside the gap. */
    .resize-handle {
        position: relative;
        z-index: 8;
        flex: 0 0 7px;
        margin: 0 -3px;
        padding: 0;
        cursor: col-resize;
        background: transparent;
        border: 0;
        touch-action: none;
    }

    .resize-handle::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 3px;
        width: 1px;
        background: transparent;
        transition:
            background 0.15s,
            width 0.15s;
    }

    .resize-handle:hover::after,
    .resize-handle:focus-visible::after,
    .resizing .resize-handle::after {
        width: 2px;
        background: var(--vis-ink-3);
    }

    .main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    /* Height comes from the row. The contents sit in an absolutely positioned
       layer so they add none of their own: in normal flow, the log's hundreds
       of events would set the row height instead of scrolling. The board gets
       the width first on smaller screens. */
    .side {
        position: relative;
        flex-shrink: 0;
        width: min(var(--side-width), 26vw);
        min-width: 260px;
        max-width: 58vw;
    }

    .side-inner {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--vis-base-200);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
    }

    .tabs {
        display: flex;
        gap: 1rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--vis-rule);
    }

    .tab {
        min-height: 40px;
        padding: 0 2px 1px;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink-3);
        background: transparent;
        border: 0;
        border-bottom: 1px solid transparent;
        cursor: pointer;
    }
    .tab:hover {
        color: var(--vis-ink-2);
    }
    /* Ink, not the accent: in dark mode the accent is close to Team A's teal. */
    .tab.on {
        color: var(--vis-ink);
        border-bottom-color: var(--vis-ink);
    }

    /* Whichever tab is showing scrolls inside the fixed column height. */
    .panel {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--vis-rule) transparent;
    }

    .panel.info {
        gap: 0.75rem;
        padding: 0.75rem;
    }

    .opt {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        margin: 0.75rem 0 0.5rem;
    }

    /* Not `.toggle`: daisyUI styles that class globally as a switch. */
    .picks {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }

    .pick {
        display: inline-flex;
        align-items: center;
        padding: 0.2rem 0.5rem;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink-3);
        background: transparent;
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        cursor: pointer;
    }
    .pick:hover {
        color: var(--vis-ink-2);
    }
    .pick.on {
        color: var(--vis-ink);
        border-color: currentColor;
    }
    /* Marker kinds wear the colour their ticks and log lines use. */
    .pick.on.death {
        color: var(--vis-log-death);
    }
    .pick.on.split {
        color: var(--vis-log-split);
    }
    .pick.on.engine {
        color: var(--vis-log-engine);
    }
    .pick.on.bot {
        color: var(--vis-log-bot);
    }

    .hint {
        margin: 0;
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        color: var(--vis-ink-3);
    }

    /* SkinOptions carries its own spacing; it only needs room off the edges. */
    .panel.options {
        padding: 0.25rem 0.75rem 0.75rem;
    }

    .stamp {
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--vis-ink-3);
    }

    .result {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }

    .result-label.map {
        color: var(--vis-ink);
    }

    .result-label {
        font-size: calc(var(--vis-text-body) * var(--font-scale, 1));
        font-weight: 600;
    }

    /* Sections are divided by rules rather than boxed, the panel being the box. */
    .block {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--vis-rule);
    }

    .row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 0.75rem;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        color: var(--vis-ink-3);
    }

    .value {
        color: var(--vis-ink);
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .swatch {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        margin-right: 0.4rem;
    }

    /* Stacked, the host scrolls instead of the panel. Only the log keeps a
       fixed height, since it follows its own tail. */
    @container (max-width: 760px) {
        .layout {
            flex-direction: column;
            flex: none;
        }
        .main {
            order: -1;
            height: clamp(360px, 65dvh, 640px);
            flex: none;
        }
        .resize-handle {
            display: none;
        }
        .side {
            width: 100%;
            max-width: none;
            min-width: 0;
        }
        .side-inner {
            position: static;
        }
        .panel {
            overflow: visible;
        }
        .panel.log {
            height: 24rem;
            overflow: auto;
        }
    }
</style>
