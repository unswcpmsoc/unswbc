import Match from "./Match.ts";
import { StaticMap } from "./Map.ts";
import { DragonAges } from "./DragonAges.ts";
import { PearlClock } from "./PearlClock.ts";
import { describeEntity } from "./describeEntity.ts";
import type { GameEvent } from "./Schema.ts";

function fixture(events: GameEvent[]) {
    const map = new StaticMap(
        2,
        2,
        new Uint8Array(4),
        new Uint8Array(6),
        new Uint8Array(6),
        [],
        [{ id: 0, team: "A", facing: "E", body: [{ x: 0, y: 0 }] }],
        Array.from({ length: 4 }, () => ({ minRounds: 0, maxRounds: 0 })),
    );
    const match = new Match(map, events);
    return (round: number) =>
        describeEntity(
            { kind: "dragon", id: "dragon:0", dragonId: 0 },
            {
                frame: match.frameAt(round),
                map: match.roundAt(round).map,
                round,
                dragonAges: new DragonAges(match),
                pearlClock: new PearlClock(match),
            },
        ).rows.find((row) => row.label === "Instructions");
}

Deno.test("instruction popup handles zero, the limit, over-limit and saturated exhaustion", () => {
    for (const [count, exceeded, expected] of [
        [0, false, "0"],
        [1234567, false, "1,234,567"],
        [100000000, false, "100,000,000"],
        [100000001, false, "INSTRUCTIONS EXCEEDED"],
        [100000000, true, "INSTRUCTIONS EXCEEDED"],
    ] as const) {
        const row = fixture([
            { type: "roundStart", round: 0 },
            { type: "turnStart", id: 0 },
            {
                type: "dragonAction",
                id: 0,
                action: exceeded ? null : { kind: "suicide" },
                tle: exceeded,
                instructions: { count, exceeded },
            },
        ])(0);
        if (row?.value !== expected || row.danger !== (expected === "INSTRUCTIONS EXCEEDED")) {
            throw new Error(JSON.stringify(row));
        }
    }
});

Deno.test("instruction usage is round-local and absent in older replays", () => {
    if (fixture([])(0)) throw new Error("invented a count for an old replay");
    const rowAt = fixture([
        { type: "roundStart", round: 0 },
        { type: "turnStart", id: 0 },
        { type: "dragonAction", id: 0, action: { kind: "suicide" }, instructions: { count: 42, exceeded: false } },
        { type: "roundStart", round: 1 },
        { type: "turnStart", id: 0 },
        { type: "dragonAction", id: 0, action: { kind: "suicide" } },
    ]);
    if (rowAt(0)?.value !== "42" || rowAt(1)) throw new Error("usage leaked between rounds");
    if (rowAt(0)?.value !== "42") throw new Error("backwards seek lost usage");
});

function tile(gap: number, events: GameEvent[]) {
    const map = new StaticMap(
        2,
        2,
        new Uint8Array(4),
        new Uint8Array(6),
        new Uint8Array(6),
        [],
        [{ id: 0, team: "A", facing: "E", body: [{ x: 0, y: 0 }] }],
        Array.from({ length: 4 }, () => ({ minRounds: gap, maxRounds: gap })),
    );
    const match = new Match(map, events);
    const rows = describeEntity(
        { kind: "cell", id: "cell:1,1", x: 1, y: 1 },
        {
            frame: match.frameAt(1),
            map: match.roundAt(1).map,
            round: 1,
            dragonAges: new DragonAges(match),
            pearlClock: new PearlClock(match),
        },
    ).rows;
    return Object.fromEntries(rows.map((row) => [row.label, row.value]));
}

Deno.test("a tile with no spawn gaps says its respawn is unknown", () => {
    const pearl: GameEvent[] = [
        { type: "roundStart", round: 0 },
        { type: "tileChange", tile: { x: 1, y: 1 }, hasPearl: true },
        { type: "roundStart", round: 1 },
    ];
    const stripped = tile(0, pearl);
    if (stripped["Respawns after"] !== "Unknown" || stripped["Next pearl"] !== "Unknown")
        throw new Error(`stripped tile read ${JSON.stringify(stripped)}`);

    const never = tile(0, [
        { type: "roundStart", round: 0 },
        { type: "roundStart", round: 1 },
    ]);
    if (never["Respawns after"] !== "Unknown" || never["Next pearl"] !== "None due")
        throw new Error(`never-spawning tile read ${JSON.stringify(never)}`);
});

Deno.test("a dragon reads as drawn now, not as the round starts or ends", () => {
    const map = new StaticMap(
        2,
        2,
        new Uint8Array(4),
        new Uint8Array(6),
        new Uint8Array(6),
        [],
        [
            {
                id: 0,
                team: "A",
                facing: "N",
                body: [
                    { x: 0, y: 0 },
                    { x: 1, y: 0 },
                    { x: 1, y: 1 },
                    { x: 0, y: 1 },
                ],
            },
        ],
        Array.from({ length: 4 }, () => ({ minRounds: 0, maxRounds: 0 })),
    );
    const match = new Match(map, [
        { type: "roundStart", round: 0 },
        { type: "turnStart", id: 0 },
        { type: "dragonAction", id: 0, action: { kind: "split", childSegmentCount: 2 } },
        {
            type: "dragonSplit",
            parentId: 0,
            childId: 1,
            team: "A",
            childFacing: "E",
            parentBody: [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
            ],
            childBody: [
                { x: 0, y: 1 },
                { x: 1, y: 1 },
            ],
        },
        { type: "roundStart", round: 1 },
    ]);
    const rows = (dragonId: number, position: number) =>
        describeEntity(
            { kind: "dragon", id: `dragon:${dragonId}`, dragonId },
            {
                frame: match.frameAt(position),
                map: match.roundAt(0).map,
                round: 0,
                dragonAges: new DragonAges(match),
                pearlClock: new PearlClock(match),
            },
        ).rows.reduce<Record<string, string>>((all, row) => ({ ...all, [row.label]: row.value }), {});
    if (rows(0, 0).Length !== "4") throw new Error(`before the split read ${rows(0, 0).Length}`);
    if (rows(0, 0.99).Length !== "2") throw new Error(`after the split read ${rows(0, 0.99).Length}`);
    const child = rows(1, 0.99);
    if (child.Age !== "0 rounds" || child.Alive !== "Yes") throw new Error(`the newborn read ${JSON.stringify(child)}`);
});
