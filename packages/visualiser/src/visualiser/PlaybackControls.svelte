<!-- Discrete replay seeking and transport controls. -->
<script lang="ts">
    import type GameRunner from "./GameRunner.svelte";
    import type Match from "./Match";
    import type { Granularity } from "./Match";
    import type { VisualiserOptions } from "./VisualiserOptions";
    import { DEFAULT_SPEED } from "./constants";
    import { settings, type MarkerKind } from "../settings.svelte";

    let {
        runner,
        match,
        options = {},
        onfullboard,
        onsnapshot,
        onhelp,
        class: className = "",
    }: {
        runner: GameRunner;
        match: Match;
        options?: VisualiserOptions;
        /** Buttons (and keys) for these only show when the host handles them. */
        onfullboard?: () => void;
        onsnapshot?: () => void;
        onhelp?: () => void;
        class?: string;
    } = $props();

    const showScrubber = $derived(options.scrubber ?? true);
    const showPlayback = $derived(options.playback ?? true);
    const showSpeed = $derived(options.speed ?? true);
    const showGranularity = $derived(options.granularity ?? true);
    const showRoundCounter = $derived(options.roundCounter ?? true);

    const speedRatios = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
    const speedRatio = $derived(runner.speed / DEFAULT_SPEED);
    const speedLabel = $derived(speedRatio < 1 ? `1/${Math.round(1 / speedRatio)}×` : `${speedRatio}×`);

    function changeSpeed(direction: -1 | 1) {
        let index = speedRatios.findIndex((ratio) => Math.abs(ratio - speedRatio) < 1e-6);
        if (index === -1)
            index = Math.max(
                0,
                speedRatios.findIndex((ratio) => ratio > speedRatio),
            );
        index = Math.max(0, Math.min(speedRatios.length - 1, index + direction));
        runner.setSpeed(DEFAULT_SPEED * speedRatios[index]);
    }

    function stepOnArrowKey(e: KeyboardEvent) {
        const by = e.shiftKey ? 10 : 1;
        if (e.code === "ArrowLeft") runner.step(-by);
        else if (e.code === "ArrowRight") runner.step(by);
        else return;
        e.preventDefault();
        // The board also steps on arrows anywhere on the page; this one has
        // focus, so it has already been handled.
        e.stopPropagation();
    }

    // Space plays, - and + change speed, Home and End jump, F fills the screen
    // with the board, ? lists these. Arrows are the board's (BoardView).
    function handleGlobalKeydown(e: KeyboardEvent) {
        if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target instanceof HTMLElement ? e.target : null;
        const typing =
            target?.isContentEditable ||
            target?.closest("select, textarea, dialog") ||
            (target?.tagName === "INPUT" && (target as HTMLInputElement).type !== "range");
        if (e.defaultPrevented || typing) return;

        const key = e.key.toLowerCase();
        const action =
            key === "-"
                ? () => changeSpeed(-1)
                : key === "=" || key === "+"
                  ? () => changeSpeed(1)
                  : key === "home"
                    ? () => scrub("0")
                    : key === "end"
                      ? () => scrub(String(runner.end))
                      : key === "f" && onfullboard
                        ? onfullboard
                        : key === "?" && onhelp
                          ? onhelp
                          : undefined;
        if (action) {
            e.preventDefault();
            action();
            return;
        }
        // Space activates a control the keyboard is on, but a button only keeps
        // the focus ring after a click, and then space is meant for playback.
        if (e.code !== "Space" || target?.closest('button, a, [role="tab"]')?.matches(":focus-visible")) return;
        e.preventDefault();
        runner.toggle();
    }

    function scrub(value: string) {
        runner.pause();
        runner.seek(Math.round(Number(value)));
    }

    function wheelScrub(e: WheelEvent) {
        e.preventDefault();
        runner.step(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
    }

    const GRANULARITY_LABELS: Record<Granularity, string> = { round: "Round", turn: "Turn", event: "Event" };

    // Timeline markers: a tick above the scrubber for each event of the kinds
    // picked in Options, in the log's colour for that kind. The other team's
    // are faded when the viewer's own team is known.

    const MARKER_EVENTS: Partial<Record<string, MarkerKind>> = {
        dragonDeath: "death",
        dragonSplit: "split",
        engineLog: "engine",
        dragonLog: "bot",
    };

    const markers = $derived.by(() => {
        const wanted = new Set(settings.markerKinds);
        const end = runner.end;
        if (!wanted.size || !end) return [];
        // Ticks closer than a thousandth of the track are one tick.
        const seen = new Set<string>();
        const out: { kind: MarkerKind; x: number; step: number; mine: boolean }[] = [];
        let index = 0;
        for (let r = 0; r < match.maxRound; r++) {
            const delta = match.deltaAt(r);
            for (let i = 0; i < delta.length; i++, index++) {
                const event = delta[i];
                const kind = MARKER_EVENTS[event.type];
                if (!kind || !wanted.has(kind)) continue;
                const team =
                    event.type === "dragonSplit"
                        ? event.team
                        : "id" in event
                          ? (match.roundAt(r).bodies.getById(event.id) ?? match.roundAt(r + 1).bodies.getById(event.id))
                                ?.team
                          : undefined;
                // Just before the event: the start of its round, or of its turn
                // or event when stepping finer, so a click plays into it.
                const step =
                    runner.granularity === "round" ? r : Math.max(0, match.stepShowing(index, runner.granularity) - 1);
                const at = Math.round((step / end) * 1000);
                const key = `${kind}:${team}:${at}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ kind, x: at / 10, step, mine: !runner.ownTeam || team === runner.ownTeam });
            }
        }
        return out;
    });

    // A click in the marker band jumps to the nearest tick within a few
    // pixels; the ticks themselves are too thin to hit.
    function jumpToMarker(e: MouseEvent) {
        const band = e.currentTarget as HTMLElement;
        const rect = band.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const reach = (6 / rect.width) * 100;
        let best: (typeof markers)[number] | undefined;
        for (const m of markers) {
            if (Math.abs(m.x - x) <= reach && (!best || Math.abs(m.x - x) < Math.abs(best.x - x))) best = m;
        }
        if (!best) return;
        runner.pause();
        runner.seek(best.step);
    }

    // Line icons in the app's sidebar style: 24-unit box, 1.5 stroke.
    const ICONS = {
        start: "M6 5v14M18 5l-9 7 9 7z",
        back: "M15 5l-7 7 7 7",
        play: "M7 4.5v15l12-7.5z",
        pause: "M8 5v14M16 5v14",
        forward: "M9 5l7 7-7 7",
        end: "M18 5v14M6 5l9 7-9 7z",
        fullboard: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
        snapshot: "M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7",
    };
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="playback {className}">
    {#if showScrubber}
        <div class="track">
            {#if markers.length}
                <svg class="marks" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                    {#each markers as m, i (i)}
                        <line x1={m.x} x2={m.x} y1="0" y2="10" class="mark {m.kind}" class:theirs={!m.mine} />
                    {/each}
                </svg>
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="marks-hit" onclick={jumpToMarker} title="Click a marker to jump to it"></div>
            {/if}
            <input
                type="range"
                class="scrub"
                min="0"
                max={runner.end}
                step="1"
                value={Math.round(runner.position)}
                style:--played="{runner.end ? (Math.round(runner.position) / runner.end) * 100 : 0}%"
                oninput={(e) => scrub(e.currentTarget.value)}
                onkeydown={stepOnArrowKey}
                onwheel={wheelScrub}
                aria-label="Seek by {runner.granularity}"
            />
        </div>
    {/if}

    <div class="row">
        {#if showPlayback}
            <div class="group">
                <button onclick={() => scrub("0")} aria-label="Jump to start">{@render icon(ICONS.start)}</button>
                <button onclick={() => runner.step(-1)} aria-label="Step back one {runner.granularity}"
                    >{@render icon(ICONS.back)}</button
                >
                <button class="play" onclick={() => runner.toggle()} aria-label={runner.playing ? "Pause" : "Play"}
                    >{@render icon(runner.playing ? ICONS.pause : ICONS.play)}</button
                >
                <button onclick={() => runner.step(1)} aria-label="Step forward one {runner.granularity}"
                    >{@render icon(ICONS.forward)}</button
                >
                <button onclick={() => scrub(String(runner.end))} aria-label="Jump to end"
                    >{@render icon(ICONS.end)}</button
                >
            </div>
        {/if}

        {#if showSpeed}
            <div class="group" aria-label="Playback speed">
                <button
                    class="speed-step"
                    onclick={() => changeSpeed(-1)}
                    disabled={speedRatio <= speedRatios[0]}
                    aria-label="Half speed"
                    title="Half speed (-)">÷2</button
                >
                <button
                    class="speed"
                    onclick={() => runner.setSpeed(DEFAULT_SPEED)}
                    disabled={speedRatio === 1}
                    aria-label="Speed {speedLabel}, reset to 1×"
                    title="Reset to 1×">{speedLabel}</button
                >
                <button
                    class="speed-step"
                    onclick={() => changeSpeed(1)}
                    disabled={speedRatio >= speedRatios[speedRatios.length - 1]}
                    aria-label="Double speed"
                    title="Double speed (+)">×2</button
                >
            </div>
        {/if}

        {#if showRoundCounter}
            <span class="counter">
                {#if showScrubber}
                    <span class="pick-label">{GRANULARITY_LABELS[runner.granularity]}</span>
                    {Math.round(runner.position)} / {runner.end}
                    {#if runner.granularity !== "round"}
                        <span class="round-context">· Round {runner.round} / {match.maxRound}</span>
                    {/if}
                {:else}
                    Round {runner.round} / {match.maxRound}
                {/if}
            </span>
        {/if}

        {#if showGranularity}
            <label class="pick"
                ><span class="pick-label">Step</span>
                <select
                    aria-label="Step by"
                    value={runner.granularity}
                    onchange={(e) => runner.setGranularity(e.currentTarget.value as Granularity)}
                >
                    {#each Object.entries(GRANULARITY_LABELS) as [value, label] (value)}
                        <option {value}>{label}</option>
                    {/each}
                </select>
            </label>
        {/if}

        {#if onfullboard || onsnapshot || onhelp}
            <div class="group">
                {#if onsnapshot}
                    <button
                        onclick={onsnapshot}
                        aria-label="Save the board as an image"
                        title="Save the board as an image">{@render icon(ICONS.snapshot)}</button
                    >
                {/if}
                {#if onfullboard}
                    <button onclick={onfullboard} aria-label="Full board" title="Full board (F)"
                        >{@render icon(ICONS.fullboard)}</button
                    >
                {/if}
                {#if onhelp}
                    <button class="help" onclick={onhelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"
                        >?</button
                    >
                {/if}
            </div>
        {/if}
    </div>
</div>

{#snippet icon(d: string)}
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><path {d} /></svg
    >
{/snippet}

<style>
    .playback {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        container-type: inline-size;
    }

    /* Markers sit in a band over the track, inset by the thumb's radius so a
       tick lines up with where the thumb would stand. */
    .track {
        position: relative;
        padding-top: 8px;
    }
    .marks {
        position: absolute;
        top: 0;
        left: 7px;
        right: 7px;
        width: calc(100% - 14px);
        height: 10px;
        pointer-events: none;
    }
    .marks-hit {
        position: absolute;
        top: 0;
        left: 7px;
        right: 7px;
        height: 10px;
        cursor: pointer;
    }
    .mark {
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
    }
    .mark.death {
        stroke: var(--vis-log-death);
    }
    .mark.split {
        stroke: var(--vis-log-split);
    }
    .mark.engine {
        stroke: var(--vis-log-engine);
    }
    .mark.bot {
        stroke: var(--vis-log-bot);
    }
    .mark.theirs {
        opacity: 0.3;
    }

    .help {
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
    }

    /* The played part of the track is filled, so position reads at a glance. */
    .scrub {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 4px;
        margin: 0.4rem 0;
        border-radius: 2px;
        background: linear-gradient(to right, var(--vis-ink-3) var(--played, 0%), var(--vis-rule) var(--played, 0%));
        outline: none;
        cursor: ew-resize;
    }
    .scrub::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--vis-ink);
        border: 2px solid var(--vis-base-200);
    }
    .scrub::-moz-range-thumb {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--vis-ink);
        border: 2px solid var(--vis-base-200);
    }
    .scrub:focus-visible::-webkit-slider-thumb {
        outline: 2px solid var(--vis-ink-2);
        outline-offset: 1px;
    }

    .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 0.75rem;
    }

    /* Buttons in a group share borders, like a segmented control. */
    .group {
        display: flex;
        align-items: stretch;
    }
    .group > * {
        margin-left: -1px;
        border-radius: 0;
    }
    .group > :first-child {
        margin-left: 0;
        border-radius: var(--vis-radius-field) 0 0 var(--vis-radius-field);
    }
    .group > :last-child {
        border-radius: 0 var(--vis-radius-field) var(--vis-radius-field) 0;
    }

    button {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 1.75rem;
        padding: 0;
        color: var(--vis-ink-2);
        background: var(--vis-base-300);
        border: 1px solid var(--vis-rule);
        cursor: pointer;
    }
    button:hover:not(:disabled) {
        color: var(--vis-ink);
        border-color: var(--vis-ink-3);
        z-index: 1;
    }
    button:disabled {
        opacity: 0.35;
        cursor: default;
    }
    .play {
        width: 2.5rem;
        color: var(--vis-ink);
    }
    svg {
        width: 0.95rem;
        height: 0.95rem;
    }

    .speed-step,
    .speed {
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-variant-numeric: tabular-nums;
    }
    .speed-step {
        width: 2.25rem;
    }
    /* The readout sits in the field colour, darker than the buttons in dark
       mode and white in light, so it reads as a display between them. It doubles as reset; at 1×
       there is nothing to reset, but it should still read as the current
       speed, not as a dead button. */
    .speed {
        width: 3rem;
        font-weight: 600;
        color: var(--vis-ink);
        background: var(--vis-field);
    }
    .speed:disabled {
        opacity: 1;
    }

    /* Takes the slack, so its width changing never moves the step select. */
    .counter {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--vis-ink-2);
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }
    .round-context {
        color: var(--vis-ink-3);
    }

    .pick {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--vis-ink-3);
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
    }
    select {
        height: 1.75rem;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        color: var(--vis-ink);
        background: var(--vis-well);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        padding: 0 0.4rem;
    }

    /* The select's value already says what it steps by, so the words go
       first when the row runs short. */
    @container (max-width: 560px) {
        .round-context,
        .pick-label {
            display: none;
        }
    }

    @container (max-width: 560px) {
        .counter {
            flex: 1 0 100%;
            order: -1;
            text-align: left;
            overflow: visible;
            white-space: normal;
        }
    }
</style>
