import { encodeReplay } from "./writer.ts";
import { buildReplay } from "./loader.ts";
import { stripBotOutput } from "./strip.ts";
import { DebugShape, type GameEvent } from "../visualiser/Schema.ts";

// A 6×6 open board: dragon 0 on team A along the top, dragon 1 on team B along
// the bottom.
function mapText(): string {
    const size = 6;
    const lines = [`MAP ${size} ${size}`, `TILE_COUNT ${size * size}`];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) lines.push(`TILE ${x} ${y} 0 0`);
    const edges: string[] = [];
    for (let row = 0; row <= 2 * size; row++) {
        for (let column = 0; column < (row % 2 === 0 ? size : size + 1); column++) {
            edges.push(`EDGE ${row * (size + 1) + column} 0 -1`);
        }
    }
    lines.push(`EDGE_COUNT ${edges.length}`, ...edges);
    lines.push("DRAGON_COUNT 2", "DRAGON 0 4 3 0 2 0 1 0 0 0", "DRAGON 1 4 3 5 2 5 1 5 0 5", "END");
    return lines.join("\n") + "\n";
}

// Both teams talk, and B's dragon 1 splits off dragon 2, which talks too.
const EVENTS: GameEvent[] = [
    { type: "roundStart", round: 0 },
    { type: "dragonAction", id: 0, action: { kind: "move", steps: ["E"] }, instructions: { count: 42, exceeded: false } },
    { type: "dragonAction", id: 1, action: null, tle: true, instructions: { count: 100000000, exceeded: true } },
    { type: "dragonLog", id: 0, text: "a log" },
    { type: "dragonIndicator", id: 0, text: "a status" },
    { type: "dragonLog", id: 1, text: "b log" },
    { type: "engineLog", id: 1, text: "can't read line: b secret" },
    {
        type: "dragonSplit",
        team: "B",
        parentId: 1,
        childId: 2,
        childFacing: "W",
        parentBody: [{ x: 3, y: 5 }, { x: 2, y: 5 }],
        childBody: [{ x: 1, y: 5 }, { x: 0, y: 5 }],
    },
    { type: "dragonIndicator", id: 2, text: "b child status" },
    // Drawings carry a bot's thinking as plainly as its logs do.
    { type: "debugDraw", id: 0, draw: { shape: DebugShape.Line, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, red: 255, green: 0, blue: 0 } },
    { type: "debugDraw", id: 1, draw: { shape: DebugShape.Dot, from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, red: 0, green: 0, blue: 255 } },
];

function botOutput(bytes: Uint8Array): string[] {
    return buildReplay(bytes)
        .events.filter((e) => e.type === "dragonLog" || e.type === "dragonIndicator" || e.type === "engineLog")
        .map((e) => (e as { text: string }).text);
}

const replay = encodeReplay({
    map: mapText(),
    botA: "a.py",
    botB: "b.py",
    events: EVENTS,
    result: {
        terminated: true,
        endReason: "roundLimit",
        winner: "A",
        teamA: { dragonCount: 1, longestDragon: 4, totalLength: 4 },
        teamB: { dragonCount: 2, longestDragon: 2, totalLength: 4 },
    },
});

function expect(got: string[], want: string[]) {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

Deno.test("each team keeps only its own bot output", () => {
    expect(botOutput(stripBotOutput(replay, "A")), ["a log", "a status"]);
    expect(botOutput(stripBotOutput(replay, "B")), ["b log", "can't read line: b secret", "b child status"]);
});

/** Which dragons' drawings survived, in order. */
function drawnBy(bytes: Uint8Array): number[] {
    return buildReplay(bytes)
        .events.filter((e) => e.type === "debugDraw")
        .map((e) => (e as { id: number }).id);
}

Deno.test("debug drawings are stripped like any other bot output", () => {
    expect(drawnBy(replay).map(String), ["0", "1"]);
    expect(drawnBy(stripBotOutput(replay, "A")).map(String), ["0"]);
    expect(drawnBy(stripBotOutput(replay, "B")).map(String), ["1"]);
    expect(drawnBy(stripBotOutput(replay, undefined)).map(String), []);
});

function bots(bytes: Uint8Array): string[] {
    const { teams } = buildReplay(bytes);
    return [teams.A.botId, teams.B.botId];
}

Deno.test("each team keeps only its own bot's name", () => {
    expect(bots(stripBotOutput(replay, "A")), ["a.py", ""]);
    expect(bots(stripBotOutput(replay, "B")), ["", "b.py"]);
    expect(bots(stripBotOutput(replay, undefined)), ["", ""]);
});

Deno.test("anyone else gets no bot output, and the game is untouched", () => {
    const stripped = stripBotOutput(replay, undefined);
    expect(botOutput(stripped), []);
    const kept = buildReplay(stripped).events.map((e) => e.type);
    expect(kept, ["roundStart", "dragonAction", "dragonAction", "dragonSplit"]);
});

// A long game reaches hundreds of thousands of events, which is more than
// capnp's default write budget allows and more than its 4KB-at-a-time arena
// growth can carry without going quadratic. Both are the writer's problem, and
// a replay nobody can strip is a replay nobody can watch.
Deno.test("a replay far bigger than capnp's defaults still strips", () => {
    const draws: GameEvent[] = [];
    for (let i = 0; i < 400_000; i++) {
        draws.push({
            type: "debugDraw",
            id: i % 2,
            draw: { shape: DebugShape.Dot, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, red: 0, green: 0, blue: 0 },
        });
    }
    const big = encodeReplay({
        map: mapText(),
        botA: "a.py",
        botB: "b.py",
        events: draws,
        result: {
            terminated: true,
            endReason: "roundLimit",
            winner: "A",
            teamA: { dragonCount: 1, longestDragon: 4, totalLength: 4 },
            teamB: { dragonCount: 1, longestDragon: 4, totalLength: 4 },
        },
    });

    // Dragon 0 is team A's and dragon 1 is team B's, so each side keeps half.
    const count = (bytes: Uint8Array) => buildReplay(bytes).events.length;
    for (const [side, want] of [["A", 200_000], ["B", 200_000], [undefined, 0]] as const) {
        const got = count(stripBotOutput(big, side));
        if (got !== want) throw new Error(`${side ?? "public"} view kept ${got} events, want ${want}`);
    }
});

Deno.test("instruction telemetry is retained only for the owning team", () => {
    for (const keep of ["A", "B", undefined] as const) {
        const actions = buildReplay(stripBotOutput(replay, keep)).events.filter(e => e.type === "dragonAction");
        if (actions.length !== 2 || actions[0].action?.kind !== "move" || actions[1].action !== null || !actions[1].tle) {
            throw new Error("stripping usage changed the action or TLE outcome");
        }
        const usage = actions.filter(e => e.instructions !== undefined);
        expect(usage.map(e => String(e.id)), keep === "A" ? ["0"] : keep === "B" ? ["1"] : []);
    }
});
