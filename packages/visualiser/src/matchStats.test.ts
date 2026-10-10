import { MatchEventStatsTracker, MatchStatsTracker } from "./matchStats.ts";
import type { GameEvent } from "./visualiser/Schema.ts";
import { StaticMap } from "./visualiser/Map.ts";
import Match from "./visualiser/Match.ts";

Deno.test("team stats sum the lengths of all living dragons", () => {
    const width = 6;
    const height = 4;
    const map = new StaticMap(
        width,
        height,
        new Uint8Array(width * height),
        new Uint8Array((height + 1) * width),
        new Uint8Array(height * (width + 1)),
        [],
        [
            {
                id: 0,
                team: "A",
                facing: "E",
                body: [
                    { x: 2, y: 0 },
                    { x: 1, y: 0 },
                    { x: 0, y: 0 },
                ],
            },
            {
                id: 1,
                team: "A",
                facing: "E",
                body: [
                    { x: 1, y: 1 },
                    { x: 0, y: 1 },
                ],
            },
            {
                id: 2,
                team: "B",
                facing: "W",
                body: [
                    { x: 4, y: 3 },
                    { x: 5, y: 3 },
                ],
            },
        ],
        Array.from({ length: width * height }, () => ({ minRounds: 0, maxRounds: 0 })),
    );

    const stats = new MatchStatsTracker(new Match(map)).statsAt(0);
    if (stats.teams.A.totalLength !== 5) {
        throw new Error(`Team A total was ${stats.teams.A.totalLength}, expected 5`);
    }
    if (stats.teams.B.totalLength !== 2) {
        throw new Error(`Team B total was ${stats.teams.B.totalLength}, expected 2`);
    }
});

function strictEqual(actual: number, expected: number) {
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}

function deepStrictEqual(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Event snapshots differ");
}

function eventMatch(events: GameEvent[]) {
    return new Match(
        new StaticMap(
            6,
            4,
            new Uint8Array(24),
            new Uint8Array(30),
            new Uint8Array(28),
            [],
            [
                {
                    id: 0,
                    team: "A",
                    facing: "E",
                    body: [
                        { x: 2, y: 0 },
                        { x: 1, y: 0 },
                        { x: 0, y: 0 },
                    ],
                },
                {
                    id: 1,
                    team: "B",
                    facing: "W",
                    body: [
                        { x: 3, y: 3 },
                        { x: 4, y: 3 },
                        { x: 5, y: 3 },
                    ],
                },
            ],
            Array.from({ length: 24 }, () => ({ minRounds: 0, maxRounds: 0 })),
        ),
        events,
    );
}

Deno.test("event totals count successful splits and assign a new child's events to its team", () => {
    const tracker = new MatchEventStatsTracker(
        eventMatch([
            { type: "roundStart", round: 0 },
            { type: "dragonAction", id: 0, action: { kind: "split", childSegmentCount: 1 } },
            {
                type: "dragonSplit",
                parentId: 0,
                childId: 2,
                team: "A",
                childFacing: "E",
                parentBody: [
                    { x: 2, y: 0 },
                    { x: 1, y: 0 },
                ],
                childBody: [{ x: 0, y: 0 }],
            },
            { type: "dragonAction", id: 2, action: { kind: "move", steps: ["E", "E"] } },
            { type: "dragonDeath", id: 2, reason: "O" },
            { type: "sonarPing", senderId: 1, direction: "W", value: 0n, origin: { x: 3, y: 3 }, end: { x: 0, y: 3 } },
            { type: "roundStart", round: 1 },
            { type: "dragonAction", id: 1, action: { kind: "move", steps: ["W"] } },
            { type: "dragonAction", id: 0, action: { kind: "split", childSegmentCount: 10 } },
            { type: "dragonDeath", id: 0, reason: "A" },
        ]),
    );
    const start = tracker.statsAt(0);
    strictEqual(start.A.lost, 0);
    const first = tracker.statsAt(1);
    strictEqual(first.A.splits, 1);
    strictEqual(first.A.sprintAttempts, 1);
    strictEqual(first.A.lost, 1);
    strictEqual(first.A.deaths.O, 1);
    strictEqual(first.B.sonarPings, 1);
    const final = tracker.statsAt(2);
    strictEqual(final.A.lost, 2);
    strictEqual(final.A.deaths.A, 1);
    strictEqual(final.A.splits, 1); // A failed request is not a split.
    strictEqual(final.B.sprintAttempts, 0); // One step is not a sprint.
    strictEqual(first.A.lost, 1); // Later rounds never mutate earlier totals.
    deepStrictEqual(tracker.statsAt(0), start);
    deepStrictEqual(tracker.statsAt(1), first);
    deepStrictEqual(tracker.statsAt(2), final);
    deepStrictEqual(tracker.statsAt(200), final);
    deepStrictEqual(tracker.statsAt(-1), start);
});

Deno.test("death totals distinguish every recorded cause for both teams", () => {
    for (const reason of ["W", "S", "O", "H", "A"] as const) {
        const tracker = new MatchEventStatsTracker(
            eventMatch([
                { type: "roundStart", round: 0 },
                { type: "dragonDeath", id: 0, reason },
                { type: "dragonDeath", id: 1, reason },
            ]),
        );
        for (const stats of Object.values(tracker.statsAt(1))) {
            strictEqual(stats.lost, 1);
            strictEqual(stats.deaths[reason], 1);
            strictEqual(
                Object.values(stats.deaths).reduce((sum, n) => sum + n, 0),
                stats.lost,
            );
        }
    }
});
