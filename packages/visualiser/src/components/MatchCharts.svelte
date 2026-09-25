<script lang="ts">
    import type { MatchStatsTracker, TeamId } from "@battledragon/visualiser";

    let {
        tracker,
        round,
        colors,
    }: {
        tracker: MatchStatsTracker;
        round: number;
        colors: Record<TeamId, string>;
    } = $props();

    type Datum = {
        round: number;
        pearls: number;
        A: number;
        B: number;
        longestA: number;
        longestB: number;
        totalA: number;
        totalB: number;
    };
    type SeriesKey = Exclude<keyof Datum, "round">;

    function datumAt(r: number): Datum {
        const stats = tracker.statsAt(r);
        return {
            round: r,
            pearls: stats.pearls,
            A: stats.teams.A.count,
            B: stats.teams.B.count,
            longestA: stats.teams.A.maxLength,
            longestB: stats.teams.B.maxLength,
            totalA: stats.teams.A.totalLength,
            totalB: stats.teams.B.totalLength,
        };
    }
    const data = $derived.by(() => {
        const points: Datum[] = [];
        const stride = Math.max(1, Math.ceil((round + 1) / 180));
        for (let r = 0; r <= round; r += stride) {
            points.push(datumAt(r));
        }
        if (points.at(-1)?.round !== round) {
            points.push(datumAt(round));
        }
        return points;
    });

    function path(key: SeriesKey, max: number): string {
        if (data.length === 0) return "";
        const xDenom = Math.max(1, round);
        const yDenom = Math.max(1, max);
        return data
            .map((point, index) => {
                const x = 5 + (point.round / xDenom) * 90;
                const y = 37 - (point[key] / yDenom) * 30;
                return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ");
    }

    // A round top for the y axis whose half is also round, so the three
    // labels read 0, 4, 8 rather than 0, 4, 7.
    function niceTop(max: number): number {
        const half = max / 2;
        if (half <= 1) return 2;
        const magnitude = 10 ** Math.floor(Math.log10(half));
        for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
            const step = m * magnitude;
            if (step >= half && Number.isInteger(step)) return step * 2;
        }
        return Math.ceil(half) * 2;
    }

    const top = (values: number[]) => niceTop(Math.max(1, ...values));

    const charts = $derived([
        {
            label: "Dragons alive",
            top: top(data.flatMap((d) => [d.A, d.B])),
            series: [["A", colors.A] as const, ["B", colors.B] as const],
        },
        {
            label: "Longest dragon alive",
            top: top(data.flatMap((d) => [d.longestA, d.longestB])),
            series: [["longestA", colors.A] as const, ["longestB", colors.B] as const],
        },
        {
            label: "Total team length",
            top: top(data.flatMap((d) => [d.totalA, d.totalB])),
            series: [["totalA", colors.A] as const, ["totalB", colors.B] as const],
        },
        {
            label: "Pearls on board",
            top: top(data.map((d) => d.pearls)),
            series: [["pearls", "var(--vis-ink-2)"] as const],
        },
    ] satisfies { label: string; top: number; series: (readonly [SeriesKey, string])[] }[]);
</script>

<section class="charts" aria-label="Stats over the match">
    <div class="heading">
        <span>Stats</span><span>{round === 0 ? "Round 0" : `Rounds 0–${round}`}</span>
    </div>
    {#if round === 0}
        <p class="empty">Play or scrub forward to see trends.</p>
    {:else}
        <div class="legend">
            <span><i style:background={colors.A}></i>Team A</span>
            <span><i style:background={colors.B}></i>Team B</span>
        </div>
        {#each charts as chart (chart.label)}
            <div class="chart">
                <div class="label">{chart.label}</div>
                <div class="plot">
                    <span class="y top">{chart.top}</span><span class="y middle">{chart.top / 2}</span><span
                        class="y bottom">0</span
                    >
                    <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label={chart.label}>
                        <path class="axis" d="M5 4V37H96" />
                        {#each chart.series as [key, color] (key)}
                            <path class="series" style:stroke={color} d={path(key, chart.top)} />
                        {/each}
                    </svg>
                    <span class="x start">0</span><span class="x end">{round}</span>
                </div>
            </div>
        {/each}
    {/if}
</section>

<style>
    .charts {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .heading {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        color: var(--vis-ink-3);
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
    }

    .heading span:last-child {
        font-weight: 400;
        font-variant-numeric: tabular-nums;
    }

    .empty {
        margin: 0;
        color: var(--vis-ink-3);
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
    }

    .legend {
        display: flex;
        gap: 0.75rem;
        color: var(--vis-ink-3);
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
    }

    .legend span {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
    }

    i {
        width: 0.55rem;
        height: 0.18rem;
    }

    .label {
        color: var(--vis-ink-2);
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        margin-bottom: 0.3rem;
    }

    .plot {
        position: relative;
        padding: 0 0 0.9rem 1.15rem;
    }

    svg {
        display: block;
        width: 100%;
        height: 5.4rem;
        overflow: visible;
    }

    .x,
    .y {
        position: absolute;
        color: var(--vis-ink-3);
        font-size: calc(0.58rem * var(--font-scale, 1));
        font-variant-numeric: tabular-nums;
        line-height: 1;
    }

    .y {
        left: 0;
        transform: translateY(-50%);
    }
    /* The plot spans y 7 to 37 of the 42-unit viewBox, 5.4rem tall. */
    .y.top {
        top: calc(5.4rem * 7 / 42);
    }
    .y.middle {
        top: calc(5.4rem * 22 / 42);
    }
    .y.bottom {
        top: calc(5.4rem * 37 / 42);
    }
    .x {
        bottom: 0;
    }
    /* Under the series' ends, which sit at x 5 and 95 of the viewBox. */
    .x.start {
        left: calc(1.15rem + (100% - 1.15rem) * 0.05);
        transform: translateX(-50%);
    }
    .x.end {
        left: calc(1.15rem + (100% - 1.15rem) * 0.95);
        transform: translateX(-50%);
    }

    .axis,
    .series {
        fill: none;
        vector-effect: non-scaling-stroke;
    }

    .axis {
        stroke: var(--vis-rule);
        stroke-width: 1;
    }

    .series {
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
    }
</style>
