<!-- Both teams side by side, so each figure compares across one row. -->
<script lang="ts">
    import type { MatchStatsAtRound, TeamEventStats } from "../matchStats";
    import { teamColor } from "../settings.svelte";
    import type { TeamInfo } from "../replay/loader";
    import type { TeamId } from "../visualiser";

    let {
        teams,
        stats,
        events,
    }: {
        teams: Record<TeamId, TeamInfo>;
        stats: MatchStatsAtRound;
        events?: Record<TeamId, TeamEventStats>;
    } = $props();

    // Living-dragon stats highlight the higher value. Cumulative event counts
    // stay neutral: more actions or deaths are not necessarily better.
    const leader = (row: { A: number; B: number }) =>
        events ? undefined : row.A > row.B ? "A" : row.B > row.A ? "B" : undefined;

    const rows = $derived(
        events
            ? [
                  { label: "Dragons lost", A: events.A.lost, B: events.B.lost },
                  { label: "Kelp deaths", A: events.A.deaths.W, B: events.B.deaths.W },
                  { label: "Self-collisions", A: events.A.deaths.S, B: events.B.deaths.S },
                  { label: "Other-body deaths", A: events.A.deaths.O, B: events.B.deaths.O },
                  { label: "Head-to-head deaths", A: events.A.deaths.H, B: events.B.deaths.H },
                  { label: "No-valid-action deaths", A: events.A.deaths.A, B: events.B.deaths.A },
                  { label: "Sprint attempts", A: events.A.sprintAttempts, B: events.B.sprintAttempts },
                  { label: "Successful splits", A: events.A.splits, B: events.B.splits },
                  { label: "Sonar pings", A: events.A.sonarPings, B: events.B.sonarPings },
              ]
            : [
                  { label: "Dragons alive", A: stats.teams.A.count, B: stats.teams.B.count },
                  { label: "Longest now", A: stats.teams.A.maxLength, B: stats.teams.B.maxLength },
                  { label: "Total length", A: stats.teams.A.totalLength, B: stats.teams.B.totalLength },
                  { label: "Longest so far", A: stats.bestLength.A, B: stats.bestLength.B },
              ],
    );
</script>

<table aria-label={events ? "Cumulative team events" : "Current team statistics"}>
    <thead>
        <tr>
            <th></th>
            {#each ["A", "B"] as const as id (id)}
                <th class="team"
                    ><span class="swatch" style:background={teamColor(teams[id])}></span>{teams[id].name}</th
                >
            {/each}
        </tr>
    </thead>
    <tbody>
        {#each rows as row (row.label)}
            <tr>
                <td class="label">{row.label}</td>
                <td class="value" style:color={leader(row) === "A" ? teamColor(teams.A) : null}>{row.A}</td>
                <td class="value" style:color={leader(row) === "B" ? teamColor(teams.B) : null}>{row.B}</td>
            </tr>
        {/each}
    </tbody>
</table>

<style>
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
    }

    th {
        padding: 0 0 0.35rem;
        border-bottom: 1px solid var(--vis-rule);
    }

    /* The labels take only what the longest needs; the teams split the rest. */
    .label,
    th:first-child {
        width: 1%;
        white-space: nowrap;
    }

    /* Names in ink, marked by the same swatch as the Teams section, so they
       don't blend with the leading figures, which take the team colour. Long
       names wrap rather than being cut off. */
    th.team {
        width: 50%;
        padding-left: 0.75rem;
        vertical-align: bottom;
        text-align: right;
        font-weight: 600;
        color: var(--vis-ink);
        overflow-wrap: anywhere;
    }

    .swatch {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        margin-right: 0.4rem;
    }

    td {
        padding: 0.25rem 0;
        color: var(--vis-ink-3);
    }

    .value {
        text-align: right;
        color: var(--vis-ink);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }
</style>
