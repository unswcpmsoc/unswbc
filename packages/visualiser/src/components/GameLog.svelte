<!-- Events up to where playback has reached. Lines are labelled by the round
     they produced; clicking one seeks to it. -->
<script lang="ts">
    import {
        DebugShape,
        type GameEvent,
        type Match,
        type DragonAction,
        type SonarHitKind,
        type TeamId,
    } from "../visualiser";
    import type GameRunner from "../visualiser/GameRunner.svelte";
    import type { TeamInfo } from "../replay/loader";
    import { untrack } from "svelte";
    import { settings, teamColor } from "../settings.svelte";

    let {
        match,
        runner,
        teams,
    }: {
        match: Match;
        runner: GameRunner;
        teams: Record<TeamId, TeamInfo>;
    } = $props();

    const SONAR_ECHO_TEXT: Record<SonarHitKind, string> = {
        empty: "empty",
        kelp: "kelp",
        ally: "ally body",
        allyHead: "ally head",
        enemy: "enemy body",
        enemyHead: "enemy head",
    };

    interface LogLine {
        key: string;
        /** The round this event produced. */
        round: number;
        /** Global index of this event, for seeking to it in any granularity. */
        index: number;
        team?: TeamId;
        /** Dragons the line is about, for filtering to a selection. */
        dragonIds?: readonly number[];
        kind: "move" | "pearl" | "spawn" | "death" | "log" | "engine" | "sonar" | "debug";
        text: string;
        /** `text` lowercased once, for search. */
        lower: string;
    }

    const DEATHS: Record<string, string> = {
        W: "hit a wall",
        S: "hit itself",
        O: "hit a body",
        H: "head-on collision",
        A: "gave no valid action",
    };

    function asked(action: DragonAction): string {
        if (action.kind === "move") return `asks to move ${action.steps.join("")}`;
        if (action.kind === "split") return `asks to split off ${action.childSegmentCount} cells`;
        return "offers nothing the rules accept";
    }

    const SHAPES: Record<number, string> = { 0: "line", 1: "dot" };

    /** One log line per event; the two structural markers get none. */
    function describe(
        event: GameEvent,
        round: number,
    ): Omit<LogLine, "key" | "round" | "index" | "lower" | "dragonIds"> | undefined {
        const teamOf = (id: number) => match.roundAt(round).bodies.getById(id)?.team;
        switch (event.type) {
            case "roundStart":
            case "turnStart":
                return undefined;
            case "tileChange":
                return {
                    kind: "pearl",
                    text: `(${event.tile.x},${event.tile.y}) ${event.hasPearl ? "pearl appears" : "pearl taken"}`,
                };
            case "pearlCountdown":
                return {
                    kind: "pearl",
                    text: `(${event.tile.x},${event.tile.y}) next pearl due in ${event.countdown}`,
                };
            case "dragonDeath":
                return {
                    kind: "death",
                    team: teamOf(event.id),
                    text: `dragon ${event.id} dies. Reason: ${DEATHS[event.reason] ?? event.reason}`,
                };
            case "dragonUpdate": {
                // Growth isn't in the event; it's the length difference either
                // side of the round. Both snapshots are cached by now.
                const was = match.roundAt(round).bodies.getById(event.id)?.body.length ?? 0;
                const now = match.roundAt(round + 1).bodies.getById(event.id)?.body.length ?? 0;
                const grew = now > was ? ` and grows to ${now}` : "";
                return {
                    kind: "move",
                    team: teamOf(event.id),
                    text: `dragon ${event.id} moves ${event.facing} to (${event.head.x},${event.head.y})${grew}`,
                };
            }
            case "dragonSplit":
                return {
                    kind: "spawn",
                    team: event.team,
                    text: `dragon ${event.parentId} splits off dragon ${event.childId}, ${event.childBody.length} cells`,
                };
            case "dragonLog":
                return { kind: "log", team: teamOf(event.id), text: `dragon ${event.id}: ${event.text}` };
            case "engineLog":
                return { kind: "engine", team: teamOf(event.id), text: `engine on dragon ${event.id}: ${event.text}` };
            case "sonarPing": {
                const hit =
                    event.hitId !== undefined
                        ? `reaches dragon ${event.hitId}`
                        : event.hitKind === "kelp"
                          ? "stops at kelp"
                          : "hits nothing";
                const echo = event.hitKind === undefined ? "" : ` (echo: ${SONAR_ECHO_TEXT[event.hitKind]})`;
                return {
                    kind: "sonar",
                    team: teamOf(event.senderId),
                    text: `dragon ${event.senderId} pings ${event.value} ${event.direction} and ${hit}${echo}`,
                };
            }
            case "debugDraw": {
                const { draw } = event;
                const at = `(${draw.from.x},${draw.from.y})`;
                const span = draw.shape === DebugShape.Dot ? at : `${at}-(${draw.to.x},${draw.to.y})`;
                return {
                    kind: "debug",
                    team: teamOf(event.id),
                    text: `dragon ${event.id} draws a ${SHAPES[draw.shape]} ${span}`,
                };
            }
            case "dragonIndicator":
                // The bot's own words, like its log lines, so it reads as bot output.
                return { kind: "log", team: teamOf(event.id), text: `dragon ${event.id}: ${event.text}` };
            case "dragonAction":
                return {
                    kind: "move",
                    team: teamOf(event.id),
                    text: `dragon ${event.id} ${event.tle ? "TLE" : event.action ? asked(event.action) : "no action"}`,
                };
        }
    }

    // How many events are on the board right now. In an event granularity the
    // log stops exactly where playback does, mid-round.
    const applied = $derived(match.appliedEvents(runner.position, runner.granularity));
    const selectedDragonIds = $derived(new Set(runner.selectedDragonIds));
    const filterActive = $derived(settings.hideUnselectedLogs && selectedDragonIds.size > 0);

    function subjectsOf(event: GameEvent): number[] | undefined {
        switch (event.type) {
            case "dragonUpdate":
            case "dragonDeath":
            case "dragonLog":
            case "engineLog":
            case "dragonIndicator":
            case "dragonAction":
            case "debugDraw":
            case "turnStart":
                return [event.id];
            case "dragonSplit":
                return [event.parentId, event.childId];
            case "sonarPing":
                return event.hitId === undefined ? [event.senderId] : [event.senderId, event.hitId];
            default:
                return undefined;
        }
    }

    const roundStarts = $derived.by(() => {
        const starts: number[] = [];
        let index = 0;
        for (let r = 0; r < match.maxRound; r++) {
            starts.push(index);
            index += match.deltaAt(r).length;
        }
        return starts;
    });

    // Each event is described once: the list is rebuilt whenever playback
    // moves, and a search reads the whole match on every keystroke.
    const described = $derived.by(() => {
        match;
        return new Map<number, LogLine | null>();
    });

    function lineAt(r: number, i: number): LogLine | null {
        const index = roundStarts[r] + i;
        let line = described.get(index);
        if (line === undefined) {
            const event = match.deltaAt(r)[i];
            const text = describe(event, r);
            line = text
                ? {
                      key: `${r}:${i}`,
                      round: r + 1,
                      index,
                      dragonIds: subjectsOf(event),
                      lower: text.text.toLowerCase(),
                      ...text,
                  }
                : null;
            described.set(index, line);
        }
        return line;
    }

    const belongsToSelection = (dragonIds: readonly number[] | undefined) =>
        dragonIds?.some((id) => selectedDragonIds.has(id)) ?? false;

    let query = $state("");
    const needle = $derived(query.trim().toLowerCase());
    // "r120", "round 120", "t120" or "turn 120" asks for a round, not text.
    const wantedRound = $derived.by(() => {
        const found = /^(?:r|t|round|turn)\s*(\d+)$/.exec(needle);
        return found ? Number(found[1]) : undefined;
    });

    // Kinds picked in the key; none picked shows every kind.
    let kinds = $state<LogLine["kind"][]>([]);
    const toggleKind = (kind: LogLine["kind"]) =>
        (kinds = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]);

    // Bot and engine lines follow the "Bot output" option.
    const BOT_KINDS: LogLine["kind"][] = ["log", "debug", "engine"];
    const shown = (line: LogLine) =>
        (runner.outputTeam === undefined || !BOT_KINDS.includes(line.kind) || line.team === runner.outputTeam) &&
        (!filterActive || belongsToSelection(line.dragonIds)) &&
        (!kinds.length || kinds.includes(line.kind)) &&
        (wantedRound !== undefined ? line.round === wantedRound : !needle || line.lower.includes(needle));

    /** Every line that passes the filters among the first `upTo` events, oldest first. */
    function collect(upTo: number): LogLine[] {
        const out: LogLine[] = [];
        for (let r = 0; r < match.maxRound && roundStarts[r] < upTo; r++) {
            const count = Math.min(match.deltaAt(r).length, upTo - roundStarts[r]);
            for (let i = 0; i < count; i++) {
                const line = lineAt(r, i);
                if (line && shown(line)) out.push(line);
            }
        }
        return out;
    }

    // Without a search, everything up to the playhead. A search covers the
    // whole match: the point is usually to find when something happened and
    // jump there.
    const lines = $derived(collect(needle ? match.eventCount : applied));

    /** The text split around each occurrence of the search, for highlighting. */
    function pieces(line: LogLine): { text: string; hit: boolean }[] {
        if (!needle || wantedRound !== undefined) return [{ text: line.text, hit: false }];
        const out: { text: string; hit: boolean }[] = [];
        let from = 0;
        for (let at = line.lower.indexOf(needle); at !== -1; at = line.lower.indexOf(needle, from)) {
            if (at > from) out.push({ text: line.text.slice(from, at), hit: false });
            out.push({ text: line.text.slice(at, at + needle.length), hit: true });
            from = at + needle.length;
        }
        if (from < line.text.length) out.push({ text: line.text.slice(from), hit: false });
        return out;
    }

    // Scrolling
    //
    // A long match has tens of thousands of lines, far more than the page can
    // hold as elements, so only the rows in view (plus a margin) are rendered,
    // inside a spacer as tall as the whole list. Rows are one line each, so
    // they share one height, measured from a real row.

    const OVERSCAN = 20;
    let scroller: HTMLElement | undefined = $state();
    let scrollTop = $state(0);
    let viewHeight = $state(0);
    let rowHeight = $state(18);

    const first = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN));
    const last = $derived(Math.min(lines.length, Math.ceil((scrollTop + viewHeight) / rowHeight) + OVERSCAN));
    const windowed = $derived(lines.slice(first, last));

    function measure(row: HTMLElement) {
        if (row.offsetHeight) rowHeight = row.offsetHeight;
    }

    // Follow the tail only while the reader is already there — scrolling up to
    // read something shouldn't get yanked back on the next round.
    let pinned = $state(true);

    function onScroll() {
        if (!scroller) return;
        scrollTop = scroller.scrollTop;
        if (!needle) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    }

    $effect(() => {
        lines.length;
        rowHeight;
        if (scroller && pinned && !needle) scroller.scrollTop = scroller.scrollHeight;
    });

    // A new search opens where playback is: at the first match still to come,
    // or at the end if they have all happened.
    $effect(() => {
        needle;
        const list = untrack(() => lines);
        const now = untrack(() => applied);
        if (!scroller || !needle) return;
        const ahead = list.findIndex((line) => line.index >= now);
        const target = ahead === -1 ? list.length : ahead;
        scroller.scrollTop = Math.max(0, target * rowHeight - scroller.clientHeight / 2);
    });

    function clearSearch() {
        query = "";
        pinned = true;
    }

    // Enter jumps playback to the next match, Shift+Enter to the one before;
    // for a round, to its first event. Escape clears.
    function searchKeys(event: KeyboardEvent) {
        if (event.key === "Escape") {
            clearSearch();
            return;
        }
        if (event.key !== "Enter" || !needle || !lines.length) return;
        event.preventDefault();
        const target =
            wantedRound !== undefined
                ? lines[0]
                : event.shiftKey
                  ? [...lines].reverse().find((line) => line.index < applied - 1)
                  : lines.find((line) => line.index >= applied);
        if (target) runner.seek(match.stepShowing(target.index, runner.granularity));
    }

    // Copying

    const asText = (line: LogLine) => `${line.round}\t${line.text}`;

    let copied: string | undefined = $state();
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;

    /** Every line the log holds under the current filters, not just the rows in view. */
    async function copyAll() {
        try {
            await navigator.clipboard.writeText(lines.map(asText).join("\n"));
            copied = `Copied ${lines.length.toLocaleString()} ${lines.length === 1 ? "line" : "lines"}`;
        } catch {
            copied = "Couldn't copy";
        }
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = undefined), 1800);
    }

    // A selection across rows copies whole lines, round first; within one row
    // the browser's own copy of the selected text is what's wanted.
    function onCopy(event: ClipboardEvent) {
        const selection = getSelection();
        if (!selection || selection.isCollapsed || !scroller || !event.clipboardData) return;
        const picked = [...scroller.querySelectorAll<HTMLElement>(".line")]
            .filter((row) => selection.containsNode(row, true))
            .map((row) => lines[Number(row.dataset.at)]);
        if (picked.length < 2) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", picked.map(asText).join("\n"));
    }

    // Rows are selectable text, so a click that ends a selection isn't a seek.
    function seekTo(line: LogLine) {
        if (!getSelection()?.isCollapsed) return;
        runner.seek(match.stepShowing(line.index, runner.granularity));
    }

    // The kinds that get a colour; moves and drawings stay grey so these stand out.
    const KEY: [LogLine["kind"], string][] = [
        ["log", "Bot output"],
        ["spawn", "Split"],
        ["death", "Death"],
        ["pearl", "Pearl"],
        ["sonar", "Sonar"],
        ["engine", "Engine"],
    ];

    function removeFilter(dragonId: number) {
        runner.selectedDragonIds = runner.selectedDragonIds.filter((selected) => selected !== dragonId);
    }
</script>

<section class="game-log">
    <header>
        <div class="tools">
            <input
                class="search"
                type="search"
                placeholder="Search, or r120 for a round"
                aria-label="Search the log"
                title="Enter jumps to the next match, Shift+Enter to the previous, Escape clears"
                bind:value={query}
                onkeydown={searchKeys}
            />
            <button class="copy" onclick={copyAll} disabled={!lines.length} title="Copy every line shown, as text">
                {copied ?? "Copy"}
            </button>
        </div>
        {#if needle}
            <p class="count">
                {lines.length.toLocaleString()}
                {wantedRound !== undefined
                    ? `${lines.length === 1 ? "event" : "events"} in round ${wantedRound}`
                    : lines.length === 1
                      ? "match"
                      : "matches"}
            </p>
        {/if}
        <div class="key" role="group" aria-label="Show only these kinds of event" class:picking={kinds.length > 0}>
            {#each KEY as [kind, label] (kind)}
                <button
                    class={kind}
                    class:on={kinds.includes(kind)}
                    aria-pressed={kinds.includes(kind)}
                    onclick={() => toggleKind(kind)}>{label}</button
                >
            {/each}
        </div>
        {#if runner.selectedDragonIds.length > 0}
            <div class="filters">
                {#each runner.selectedDragonIds as dragonId (dragonId)}
                    <button
                        class="chip"
                        onclick={() => removeFilter(dragonId)}
                        aria-label="Remove dragon {dragonId} from log filter"
                    >
                        Dragon {dragonId} &times;
                    </button>
                {/each}
            </div>
        {/if}
    </header>
    <div class="scroller" bind:this={scroller} bind:clientHeight={viewHeight} onscroll={onScroll} oncopy={onCopy}>
        {#if lines.length === 0}
            <p class="empty">
                {needle || kinds.length
                    ? "Nothing in the log matches these filters."
                    : filterActive && applied > 0
                      ? "No events for the selected dragons yet."
                      : "Play or scrub forward to see events."}
            </p>
        {:else}
            <div class="spacer" style:height="{lines.length * rowHeight}px">
                <div class="rows" style:transform="translateY({first * rowHeight}px)">
                    {#each windowed as line, i (line.key)}
                        <div
                            class="line {line.kind}"
                            class:ahead={needle && line.index >= applied}
                            class:dimmed={!settings.hideUnselectedLogs &&
                                selectedDragonIds.size > 0 &&
                                !belongsToSelection(line.dragonIds)}
                            role="button"
                            tabindex="0"
                            data-at={first + i}
                            use:measure
                            onclick={() => seekTo(line)}
                            onkeydown={(e) => {
                                if (e.key === "Enter") seekTo(line);
                            }}
                        >
                            <span class="round">{String(line.round).padStart(3, "0")}</span>
                            <span class="dot" style:background={line.team ? teamColor(teams[line.team]) : "transparent"}
                            ></span>
                            <span class="text" title={line.text}
                                >{#each pieces(line) as piece, j (j)}{#if piece.hit}<mark>{piece.text}</mark
                                        >{:else}{piece.text}{/if}{/each}</span
                            >
                        </div>
                    {/each}
                </div>
            </div>
        {/if}
    </div>
</section>

<style>
    .game-log {
        flex: 1;
        min-height: 12rem;
        display: flex;
        flex-direction: column;
        background: var(--vis-base-200);
        border-top: 1px solid var(--vis-rule);
    }

    header {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 7px 12px;
        border-bottom: 1px solid var(--vis-rule);
    }

    .tools {
        display: flex;
        gap: 6px;
    }

    .search {
        flex: 1;
        min-width: 0;
        height: 1.75rem;
        padding: 0 0.5rem;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        color: var(--vis-ink);
        background: var(--vis-field);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        outline: none;
    }
    .search:focus {
        border-color: var(--vis-ink-3);
    }
    .search::placeholder {
        color: var(--vis-ink-3);
    }

    .copy {
        flex-shrink: 0;
        min-width: 3.5rem;
        height: 1.75rem;
        padding: 0 0.6rem;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        color: var(--vis-ink-2);
        background: var(--vis-base-300);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        cursor: pointer;
    }
    .copy:hover:not(:disabled) {
        color: var(--vis-ink);
        border-color: var(--vis-ink-3);
    }
    .copy:disabled {
        opacity: 0.4;
        cursor: default;
    }

    .count {
        margin: 0;
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        color: var(--vis-ink-3);
        font-variant-numeric: tabular-nums;
    }

    /* The key doubles as a filter: click kinds to show only those. */
    /* Bordered like the Options toggles; the text keeps each kind's colour,
       since this is also the key to the log's colours. */
    .key {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }

    .key button {
        display: inline-flex;
        align-items: center;
        padding: 0.2rem 0.5rem;
        font-family: inherit;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        background: transparent;
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        cursor: pointer;
    }

    .key button.on {
        border-color: currentColor;
    }

    /* While some are picked, the rest fall back so the choice reads. */
    .key.picking button:not(.on) {
        opacity: 0.4;
    }

    .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
    }

    .scroller {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--vis-rule) transparent;
    }

    .spacer {
        position: relative;
    }

    /* Rows are text you can select and copy; a plain click still seeks. */
    .line {
        user-select: text;
    }

    /* Search matches playback hasn't reached yet. */
    .line.ahead {
        opacity: 0.55;
    }

    mark {
        color: inherit;
        font-weight: 700;
        background: var(--vis-press);
    }

    .empty {
        margin: 0;
        padding: 8px 12px;
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        color: var(--vis-ink-3);
    }

    .line {
        display: flex;
        align-items: baseline;
        gap: 8px;
        width: 100%;
        padding: 1px 12px;
        font-family: inherit;
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        line-height: 1.55;
        text-align: left;
        color: var(--vis-ink-3);
        background: none;
        border: none;
        cursor: pointer;
    }

    /* A selection keeps the other dragons' lines in place but out of the way, so
	   the log doesn't jump around as the selection changes. */
    .line.dimmed {
        opacity: 0.28;
    }

    .chip {
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        color: var(--vis-ink);
        background: var(--vis-base-300);
        border: 1px solid var(--vis-rule);
        border-radius: 2px;
        padding: 1px 5px;
        cursor: pointer;
    }

    .line:hover {
        background: var(--vis-base-300);
        color: var(--vis-ink-2);
    }

    /* One row per event; wrapped rows made the column ragged. The full text is
       in the title. */
    .text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .round {
        flex-shrink: 0;
        color: color-mix(in srgb, var(--vis-ink-3) 55%, var(--vis-base-200));
        font-variant-numeric: tabular-nums;
    }

    .dot {
        flex-shrink: 0;
        width: 6px;
        height: 6px;
    }

    /* Moves are most of the log and the board already shows them, so they sit
	   back and let the events you actually scan for come forward. */
    .line.move .text {
        color: color-mix(in srgb, var(--vis-ink-3) 75%, var(--vis-base-200));
    }

    /* The key and the lines share these, so a line reads as its key entry. */
    .key .log,
    .line.log .text {
        color: var(--vis-log-bot);
    }

    .key .spawn,
    .line.spawn .text {
        color: var(--vis-log-split);
    }

    .key .death,
    .line.death .text {
        color: var(--vis-log-death);
    }

    .key .pearl,
    .line.pearl .text {
        color: var(--vis-log-pearl);
    }

    .key .sonar,
    .line.sonar .text {
        color: var(--vis-log-sonar);
    }

    .key .engine,
    .line.engine .text {
        color: var(--vis-log-engine);
    }

    .line.debug .text {
        color: var(--vis-ink-3);
    }
</style>
