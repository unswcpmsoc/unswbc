import * as capnp from "capnp-es";
import { encodeReplay } from "./writer.ts";
import { ReplayError } from "./errors.ts";
import { stripBotOutput } from "./strip.ts";
import { asDownloadProgress, asLoadProgress, buildReplay, buildReplayAsync, DOWNLOAD_SHARE } from "./loader.ts";
import { gameEventFromCapnp } from "./capnpCodec.ts";
import { Replay as CapnpReplay, REPLAY_FORMAT_VERSION } from "./generated/replay.ts";
import { DebugShape, DragonDeathReason, type GameEvent } from "../visualiser/Schema.ts";

function tinyMapText(width: number, height: number): string {
    const lines = [`MAP ${width} ${height}`, `TILE_COUNT ${width * height}`];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) lines.push(`TILE ${x} ${y} 0 0`);
    }
    const edges: string[] = [];
    for (let row = 0; row <= 2 * height; row++) {
        const columns = row % 2 === 0 ? width : width + 1;
        for (let column = 0; column < columns; column++) {
            edges.push(`EDGE ${row * (width + 1) + column} 0 -1`);
        }
    }
    lines.push(`EDGE_COUNT ${edges.length}`, ...edges);
    // Dragon 0 (team A) heads east along the top row; dragon 1 (team B) sits in the bottom right.
    lines.push(
        "DRAGON_COUNT 2",
        "DRAGON 0 4 3 0 2 0 1 0 0 0",
        `DRAGON 1 2 ${width - 2} ${height - 1} ${width - 1} ${height - 1}`,
    );
    lines.push("END");
    return lines.join("\n") + "\n";
}

const MAP_TEXT = tinyMapText(8, 8);

/** One of every event kind, in an order the grammar allows. */
const EVERY_EVENT_KIND: GameEvent[] = [
    { type: "roundStart", round: 0 },
    { type: "tileChange", tile: { x: 1, y: 1 }, hasPearl: true },
    { type: "pearlCountdown", tile: { x: 1, y: 1 }, countdown: 65535 },
    { type: "turnStart", id: 0 },
    { type: "dragonLog", id: 0, text: "eating at 4,3" },
    {
        type: "debugDraw",
        id: 0,
        draw: { shape: DebugShape.Line, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, red: 0, green: 128, blue: 255 },
    },
    {
        type: "debugDraw",
        id: 0,
        draw: { shape: DebugShape.Dot, from: { x: 2, y: 2 }, to: { x: 2, y: 2 }, red: 255, green: 255, blue: 0 },
    },
    { type: "engineLog", id: 0, text: "can't read line: SONAR 43 BULLSHIT" },
    { type: "dragonIndicator", id: 0, text: "hunting" },
    { type: "dragonAction", id: 0, action: { kind: "move", steps: ["S", "S"] }, instructions: { count: 12345678, exceeded: false } },
    { type: "dragonUpdate", id: 0, facing: "S", head: { x: 3, y: 1 }, tail: { x: 1, y: 0 } },
    { type: "dragonUpdate", id: 0, facing: "S", head: { x: 3, y: 2 }, tail: { x: 3, y: 0 } },
    {
        type: "sonarPing",
        senderId: 0,
        direction: "S",
        value: 18446744073709551615n,
        origin: { x: 3, y: 2 },
        end: { x: 6, y: 7 },
        hitId: 1,
        hitKind: "enemyHead",
    },
    { type: "turnStart", id: 1 },
    { type: "dragonAction", id: 1, action: { kind: "split", childSegmentCount: 1 } },
    {
        type: "dragonSplit",
        parentId: 1,
        childId: 2,
        team: "B",
        childFacing: "W",
        parentBody: [{ x: 6, y: 7 }],
        childBody: [{ x: 7, y: 7 }],
    },
    {
        type: "sonarPing",
        senderId: 1,
        direction: "W",
        value: 42n,
        origin: { x: 6, y: 7 },
        end: { x: 0, y: 7 },
        hitKind: "kelp",
    },
    { type: "turnStart", id: 2 },
    { type: "dragonAction", id: 2, action: null, tle: true, instructions: { count: 100000000, exceeded: true } },
    { type: "dragonDeath", id: 2, reason: DragonDeathReason.NoValidAction },
    { type: "tileChange", tile: { x: 7, y: 7 }, hasPearl: true },
];

function canonical(value: unknown): string {
    if (typeof value === "bigint") return `${value}n`;
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
}

function encode(events: GameEvent[]): Uint8Array {
    return encodeReplay({
        map: MAP_TEXT,
        botA: "a.py",
        botB: "b.py",
        events,
        result: {
            terminated: true,
            endReason: "roundLimit",
            winner: "A",
            teamA: { dragonCount: 1, longestDragon: 4, totalLength: 4 },
            teamB: { dragonCount: 1, longestDragon: 1, totalLength: 1 },
        },
    });
}

Deno.test("every event kind survives a capnp round trip", () => {
    const root = new capnp.Message(encode(EVERY_EVENT_KIND), true).getRoot(CapnpReplay);
    const read = [...root.events].map((event) => gameEventFromCapnp(event, root.formatVersion));

    if (read.length !== EVERY_EVENT_KIND.length) {
        throw new Error(`wrote ${EVERY_EVENT_KIND.length} events, read back ${read.length}`);
    }
    for (const [i, wrote] of EVERY_EVENT_KIND.entries()) {
        if (canonical(wrote) !== canonical(read[i])) {
            throw new Error(
                `event ${i} (${wrote.type}) changed\n  wrote ${canonical(wrote)}\n  read  ${canonical(read[i])}`,
            );
        }
    }
});

Deno.test("the envelope survives too", () => {
    const { teams, result } = buildReplay(encode(EVERY_EVENT_KIND));
    if (teams.A.botId !== "a.py" || teams.B.botId !== "b.py")
        throw new Error(`bots read back as ${teams.A.botId}, ${teams.B.botId}`);
    if (result.winner !== "A" || result.endReason !== "roundLimit" || !result.terminated) {
        throw new Error(`result read back as ${JSON.stringify(result)}`);
    }
    if (result.teamA.longestDragon !== 4 || result.teamB.totalLength !== 1) {
        throw new Error(`standings read back as ${JSON.stringify(result)}`);
    }
});

Deno.test("buildReplayAsync matches buildReplay", async () => {
    const bytes = encode(EVERY_EVENT_KIND);
    const sync = buildReplay(bytes);
    const streamed = await buildReplayAsync(bytes);
    if (sync.events.length !== streamed.events.length || sync.result.winner !== streamed.result.winner) {
        throw new Error("async decode diverged from the sync path");
    }
});

Deno.test("download then load fill one bar", () => {
    const mid = asDownloadProgress({ loaded: 50, total: 100 });
    if (mid.phase !== "download" || mid.fraction !== DOWNLOAD_SHARE * 0.5) {
        throw new Error(`mid-download was ${JSON.stringify(mid)}`);
    }
    const done = asLoadProgress(1, 100);
    if (done.phase !== "load" || done.fraction !== 1) {
        throw new Error(`finished load was ${JSON.stringify(done)}`);
    }
});

/** Event steps: one per timed event (moves, deaths, splits), and one for any window that has none. */
function expectedEventSteps(events: GameEvent[]): number {
    const timed = new Set(["dragonUpdate", "dragonDeath", "dragonSplit"]);
    let steps = 0;
    let inWindow = false;
    let timedInWindow = 0;
    const closeWindow = () => {
        if (inWindow) steps += Math.max(1, timedInWindow);
        inWindow = false;
        timedInWindow = 0;
    };
    let inRound = false;
    let roundHadWindow = false;
    for (const event of events) {
        if (event.type === "roundStart") {
            closeWindow();
            if (inRound && !roundHadWindow) steps += 1;
            inRound = true;
            roundHadWindow = false;
            continue;
        }
        if (event.type === "turnStart") closeWindow();
        if (!inWindow) {
            inWindow = true;
            roundHadWindow = true;
        }
        if (timed.has(event.type)) timedInWindow++;
    }
    closeWindow();
    if (inRound && !roundHadWindow) steps += 1;
    return steps;
}

Deno.test("step boundaries follow round and turn starts", () => {
    const { match } = buildReplay(encode(EVERY_EVENT_KIND));
    // One round; its windows are the pearl tick, then dragons 0, 1 and 2.
    const expected = { round: 1, turn: 4, event: expectedEventSteps(EVERY_EVENT_KIND) };
    for (const [granularity, steps] of Object.entries(expected)) {
        const actual = match.endFor(granularity as keyof typeof expected);
        if (actual !== steps) throw new Error(`${granularity} granularity: expected ${steps} steps, got ${actual}`);
    }
});

Deno.test("an empty round still costs one step at every granularity", () => {
    const events: GameEvent[] = [
        { type: "roundStart", round: 0 },
        ...EVERY_EVENT_KIND.map((e) => (e.type === "roundStart" ? { ...e, round: 1 } : e)),
        { type: "roundStart", round: 2 },
    ];
    const { match } = buildReplay(encode(events));

    if (match.endFor("round") !== 3) throw new Error(`expected 3 round steps, got ${match.endFor("round")}`);
    if (match.endFor("turn") !== 4 + 2) throw new Error(`expected 6 turn steps, got ${match.endFor("turn")}`);
    if (match.endFor("event") !== expectedEventSteps(events)) {
        throw new Error(`expected ${expectedEventSteps(events)} event steps, got ${match.endFor("event")}`);
    }
});

Deno.test("events before the first round are init events", () => {
    const events: GameEvent[] = [
        { type: "pearlCountdown", tile: { x: 0, y: 0 }, countdown: 3 },
        { type: "dragonUpdate", id: 0, facing: "E", head: { x: 3, y: 0 }, tail: { x: 0, y: 0 } },
        { type: "roundStart", round: 0 },
    ];
    const { match } = buildReplay(encode(events));
    if (match.initEvents.length !== 2 || match.maxRound !== 1 || match.deltaAt(0).length !== 0) {
        throw new Error(`got ${match.initEvents.length} init events and ${match.maxRound} rounds`);
    }
});

Deno.test("a split re-bodies the parent and births the child", () => {
    const split = EVERY_EVENT_KIND.find((e) => e.type === "dragonSplit")!;
    if (split.type !== "dragonSplit") throw new Error("fixture lost its split event");

    const { match } = buildReplay(encode([{ type: "roundStart", round: 0 }, split]));
    const bodies = match.roundAt(1).bodies;

    const parent = bodies.getById(split.parentId);
    const child = bodies.getById(split.childId);
    if (parent?.body.length !== split.parentBody.length) {
        throw new Error(`parent kept ${parent?.body.length} cells, expected ${split.parentBody.length}`);
    }
    if (child?.body.length !== split.childBody.length) {
        throw new Error(`child got ${child?.body.length} cells, expected ${split.childBody.length}`);
    }
    if (child.team !== split.team || child.facing !== split.childFacing) {
        throw new Error(`child is ${child.team}/${child.facing}, expected ${split.team}/${split.childFacing}`);
    }
});

Deno.test("a multi-step move retracts the tail to the declared cell", () => {
    // Dragon 0 starts at 3,0 2,0 1,0 0,0. Two cells of head advance against one
    // cell of tail retreat on the first step, then the paid second step.
    const { match } = buildReplay(
        encode([
            { type: "roundStart", round: 0 },
            { type: "turnStart", id: 0 },
            { type: "dragonUpdate", id: 0, facing: "E", head: { x: 4, y: 0 }, tail: { x: 1, y: 0 } },
            { type: "dragonUpdate", id: 0, facing: "E", head: { x: 5, y: 0 }, tail: { x: 3, y: 0 } },
        ]),
    );

    const dragon = match.roundAt(1).bodies.getById(0)!;
    const cells = dragon.body.map((c) => `${c.x},${c.y}`).join(" ");
    if (cells !== "5,0 4,0 3,0") throw new Error(`body is "${cells}", expected "5,0 4,0 3,0"`);
});

function mutateReplay(change: (root: CapnpReplay) => void): Uint8Array {
    const message = new capnp.Message(encode(EVERY_EVENT_KIND), true);
    change(message.getRoot(CapnpReplay));
    return new Uint8Array(message.toPackedArrayBuffer());
}

async function expectMismatch(bytes: Uint8Array) {
    for (const decode of [buildReplay, buildReplayAsync]) {
        try {
            await decode(bytes);
        } catch (error) {
            if (error instanceof ReplayError && error.kind === "schema-mismatch") continue;
            throw error;
        }
        throw new Error("unsupported replay was accepted");
    }
}

Deno.test("writers stamp the format version, including team replay views", () => {
    for (const bytes of [encode(EVERY_EVENT_KIND), stripBotOutput(encode(EVERY_EVENT_KIND), "A")]) {
        const root = new capnp.Message(bytes, true).getRoot(CapnpReplay);
        if (root.formatVersion !== REPLAY_FORMAT_VERSION) throw new Error("missing format version");
    }
});

Deno.test("future formats fail before decoding an incompatible map or event", async () => {
    const message = new capnp.Message();
    const root = message.initRoot(CapnpReplay);
    root.formatVersion = REPLAY_FORMAT_VERSION + 1;
    root.map = "FUTURE MAP FORMAT";
    const bytes = new Uint8Array(message.toPackedArrayBuffer());
    await expectMismatch(bytes);
    try {
        stripBotOutput(bytes, "A");
    } catch (error) {
        if (error instanceof ReplayError && error.kind === "schema-mismatch") return;
        throw error;
    }
    throw new Error("team view rewrote an unsupported replay");
});

Deno.test("legacy unversioned replays still open", async () => {
    const bytes = await Deno.readFile(new URL("../../../../frontend/static/replays/docs-demo.replay", import.meta.url));
    if (new capnp.Message(bytes, true).getRoot(CapnpReplay).formatVersion !== 0) {
        throw new Error("fixture is no longer a legacy replay");
    }
    const loaded = buildReplay(bytes);
    if (loaded.events.length === 0) throw new Error("legacy events were lost");
    if ((await buildReplayAsync(bytes)).events.length !== loaded.events.length) {
        throw new Error("async legacy decode differs");
    }
});

Deno.test("unknown events and actions request an update even without a version bump", async () => {
    await expectMismatch(mutateReplay(root => capnp.utils.setUint16(0, 65535, root.events.get(0))));
    await expectMismatch(mutateReplay(root => {
        const action = [...root.events].find(e => e._isDragonAction)!.dragonAction.action;
        capnp.utils.setUint16(0, 65535, action);
    }));
});

Deno.test("unknown result enums request an update instead of assuming round limit", async () => {
    await expectMismatch(mutateReplay(root => { root.result.endReason = 65535 as never; }));
});

Deno.test("a format 1 sonar ping keeps its 32-bit value and has no hit kind", () => {
    const bytes = mutateReplay((root) => {
        root.formatVersion = 1;
        for (const event of root.events) {
            if (!event._isSonarPing) continue;
            event.sonarPing.value = 4294967295;
            event.sonarPing.value64 = 0n;
            event.sonarPing.hitKind = 0;
        }
    });
    const pings = buildReplay(bytes).events.filter((event) => event.type === "sonarPing");
    if (pings.length === 0) throw new Error("no sonar pings in the fixture");
    for (const ping of pings) {
        if (ping.value !== 4294967295n || ping.hitKind !== undefined) {
            throw new Error(`format 1 ping read back as ${ping.value} ${ping.hitKind}`);
        }
    }
});
