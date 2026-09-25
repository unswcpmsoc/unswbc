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
