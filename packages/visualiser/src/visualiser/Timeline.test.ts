// The timeline's promises, checked against real recorded matches: motion is
// continuous, bodies stay connected, splits stand still, deaths happen where
// the engine says, and every granularity shows the same motion.
//
// The repo ships no replays, so these tests are skipped unless you point them
// at your own. Record one and run them:
//
//     make run -- maps/small.map examples/dummy examples/dummy match.replay
//     REPLAYS=../../match.replay deno task test
//
// REPLAYS is a comma-separated list of paths, each relative to this package.

import { buildReplay } from "../replay/loader.ts";
import Match from "./Match.ts";
import { DragonDeathReason, type GameEvent } from "./Schema.ts";
import { stepBetween } from "./Bodies.ts";
import { vectorEq, type Vector } from "./Vector.ts";

const REPLAYS = (Deno.env.get("REPLAYS") ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
const CELL = 32;
const TAUS = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.999];

// Skipped rather than passed when there is nothing to read: a vacuous green
// would claim coverage these tests do not have.
const test = (name: string, fn: () => void) => Deno.test({ name, ignore: REPLAYS.length === 0, fn });

function loadMatches(): Match[] {
    return REPLAYS.map((path) => buildReplay(Deno.readFileSync(path)).match);
}

const key = (c: Vector) => `${c.x},${c.y}`;

test("every occupied cell is one step from the next: no gaps between body and tail", () => {
    for (const match of loadMatches()) {
        for (let r = 0; r < match.maxRound; r++) {
            const timeline = match.timeline(r, 0.35);
            const map = timeline.end.map;
            for (const tau of TAUS) {
                for (const view of timeline.views(tau, CELL)) {
                    for (let i = 1; i < view.occupancy.length; i++) {
                        const a = view.occupancy[i - 1].cell;
                        const b = view.occupancy[i].cell;
                        if (!stepBetween(a, b, map, map.portals)) {
                            throw new Error(
                                `round ${r} τ=${tau} dragon ${view.id}: (${a.x},${a.y}) to (${b.x},${b.y}) is not one step`,
                            );
                        }
                    }
                }
            }
        }
    }
});

test("heads and tails move continuously", () => {
    for (const match of loadMatches()) {
        for (let r = 0; r < match.maxRound; r++) {
            const timeline = match.timeline(r, 0.35);
            const map = timeline.end.map;
            let previous = new Map<number, { head: Vector; tail: Vector }>();
            for (let step = 0; step <= 40; step++) {
                const tau = Math.min(0.999, step / 40);
                const current = new Map<number, { head: Vector; tail: Vector }>();
                for (const view of timeline.views(tau, CELL)) {
                    if (view.dissolve !== undefined) continue;
                    current.set(view.id, { head: view.head, tail: view.tail });
                    const before = previous.get(view.id);
                    if (!before) continue;
                    for (const end of ["head", "tail"] as const) {
                        const a = before[end];
                        const b = view[end];
                        const moved = Math.hypot(a.x - b.x, a.y - b.y);
                        // A seam or portal crossing legitimately jumps; anything else
                        // must move less than a cell between samples.
                        const jumped = moved > CELL * 0.6;
                        const crossing =
                            Math.abs(a.x - b.x) > CELL * (map.width - 2) ||
                            Math.abs(a.y - b.y) > CELL * (map.height - 2) ||
                            map.portals.length > 0;
                        if (jumped && !crossing) {
                            throw new Error(
                                `round ${r} τ=${tau.toFixed(3)} dragon ${view.id} ${end} jumped ${moved.toFixed(1)}px`,
                            );
                        }
                    }
                }
                previous = current;
            }
        }
    }
});

test("in acting order, no cell has two living occupants", () => {
    for (const match of loadMatches()) {
        for (let r = 0; r < match.maxRound; r++) {
            const timeline = match.timeline(r, 1);
            for (const tau of TAUS) {
                const owner = new Map<string, number>();
                for (const view of timeline.views(tau, CELL)) {
                    if (view.dissolve !== undefined || view.ghost) continue;
                    for (const cover of view.occupancy) {
                        // A cell counts as occupied while any of the dragon is in it.
                        const inIt =
                            cover.to - cover.from > 1e-6 ||
                            cover === view.occupancy[0] ||
                            cover === view.occupancy[view.occupancy.length - 1];
                        if (!inIt) continue;
                        const k = key(cover.cell);
                        const other = owner.get(k);
                        if (other !== undefined && other !== view.id) {
                            throw new Error(`round ${r} τ=${tau}: cell ${k} held by dragons ${other} and ${view.id}`);
                        }
                        owner.set(k, view.id);
                    }
                }
            }
        }
    }
});

test("a split moves nothing", () => {
    for (const match of loadMatches()) {
        for (let r = 0; r < match.maxRound; r++) {
            const split = match.deltaAt(r).find((e) => e.type === "dragonSplit");
            if (!split || split.type !== "dragonSplit") continue;
            const timeline = match.timeline(r, 1);
            const segment = timeline.dragons.get(split.parentId)!.segments.find((s) => s.kind === "split")!;
            const poses = new Map<number, string>();
            for (const tau of [
                segment.at.start + 1e-6,
                (segment.at.start + segment.at.end) / 2,
                segment.at.end - 1e-6,
            ]) {
                for (const view of timeline.views(tau, CELL)) {
                    if (view.ghost || (view.id !== split.parentId && view.id !== split.childId)) continue;
                    const pose = `${view.head.x},${view.head.y}|${view.tail.x},${view.tail.y}`;
                    const seen = poses.get(view.id);
                    if (seen !== undefined && seen !== pose) {
                        throw new Error(`round ${r} dragon ${view.id} moved during its split: ${seen} -> ${pose}`);
                    }
                    poses.set(view.id, pose);
                }
            }
            if (poses.size !== 2)
                throw new Error(`round ${r}: expected parent and child on the board, saw ${poses.size}`);
            // The old body fades out as the two new dragons fade in.
            const mid = timeline.views((segment.at.start + segment.at.end) / 2, CELL);
            const ghost = mid.find((v) => v.ghost && v.id === split.parentId);
            const parent = mid.find((v) => !v.ghost && v.id === split.parentId);
            const child = mid.find((v) => v.id === split.childId);
            if (!ghost || ghost.cells.length !== split.parentBody.length + split.childBody.length) {
                throw new Error(`round ${r}: no fading image of the whole pre-split body`);
            }
            if (
                Math.abs(ghost.alpha - 0.5) > 1e-6 ||
                Math.abs((parent?.alpha ?? 0) - 0.5) > 1e-6 ||
                Math.abs((child?.alpha ?? 0) - 0.5) > 1e-6
            ) {
                throw new Error(
                    `round ${r}: mid-split alphas are ghost ${ghost.alpha}, parent ${parent?.alpha}, child ${child?.alpha}; expected 0.5 each`,
                );
            }
        }
    }
});

test("a sonar ping follows the engine path: through a portal, stopping short of kelp", () => {
    // An 8x2 board; the east side of (3,0) is glued to the west side of (6,1),
    // and kelp closes the east side of (7,1). Edge ids: row*(w+1)+column.
    const portalA = 1 * 9 + 4; // (3,0) east
    const portalB = 3 * 9 + 6; // (6,1) west
    const kelp = 3 * 9 + 8; // (7,1) east
    const map = tinyMap(8, 2, { [portalA]: [2, 0], [portalB]: [2, 0], [kelp]: [1, -1] }, [
        {
            team: 0,
            body: [
                [1, 0],
                [0, 0],
            ],
        },
    ]);
    const match = Match.fromMapText(map, [
        { type: "roundStart", round: 0 },
        { type: "turnStart", id: 0 },
        { type: "sonarPing", senderId: 0, direction: "E", value: 7n, origin: { x: 1, y: 0 }, end: { x: 7, y: 1 } },
    ]);
    const [ping] = match.timeline(0, 1).pings;
    const cells = ping.path.map((c) => `${c.x},${c.y}`).join(" ");
    if (cells !== "1,0 2,0 3,0 6,1 7,1") {
        throw new Error(`sonar path is "${cells}", expected "1,0 2,0 3,0 6,1 7,1"`);
    }
});

test("a dragon dies where the engine says, and its pearls fall on that body", () => {
    for (const match of loadMatches()) {
        for (let r = 0; r < match.maxRound; r++) {
            const delta = match.deltaAt(r);
            const timeline = match.timeline(r, 1);
            const state = match.roundAt(r).copy();
            for (let i = 0; i < delta.length; i++) {
                const event = delta[i];
                if (event.type === "dragonDeath") {
                    const engineBody = state.bodies.getById(event.id)?.body ?? [];
                    const track = timeline.dragons.get(event.id)!;
                    const die = track.segments.find((s) => s.kind === "die");
                    if (!die || die.kind !== "die")
                        throw new Error(`round ${r}: no die segment for dragon ${event.id}`);
                    if (
                        die.body.length !== engineBody.length ||
                        !die.body.every((c, k) => vectorEq(c, engineBody[k]))
                    ) {
                        throw new Error(`round ${r}: dragon ${event.id} dies on a different body than the engine's`);
                    }
                    // The pearls it drops are the tileChanges that directly follow.
                    for (let j = i + 1; j < delta.length; j++) {
                        const drop = delta[j];
                        if (drop.type !== "tileChange" || !drop.hasPearl) break;
                        const { x, y } = drop.tile;
                        if (!engineBody.some((c) => c.x === x && c.y === y)) {
                            throw new Error(`round ${r}: pearl at (${x},${y}) is off dragon ${event.id}'s body`);
                        }
                        const change = timeline.pearls.find((p) => p.cell.x === x && p.cell.y === y && p.grow);
                        if (!change || change.at.start !== die.at.start) {
                            throw new Error(`round ${r}: dropped pearl at (${x},${y}) does not appear with the death`);
                        }
                    }
                }
                state.applyEvents([event]);
            }
        }
    }
});

test("stepping by turn or event shows the same motion as the round in acting order", () => {
    for (const match of loadMatches()) {
        for (const granularity of ["turn", "event"] as const) {
            const end = match.endFor(granularity);
            for (let position = 0; position < end; position += Math.max(1, Math.floor(end / 400)) + 0.37) {
                const fine = match.frameAt(position, granularity);
                const whole = match.timeline(fine.round, 1);
                const a = fine.timeline.views(fine.tau, CELL);
                const b = whole.views(fine.tau, CELL);
                if (a.length !== b.length)
                    throw new Error(`${granularity} ${position}: ${a.length} vs ${b.length} dragons`);
                for (let i = 0; i < a.length; i++) {
                    if (
                        a[i].id !== b[i].id ||
                        Math.abs(a[i].head.x - b[i].head.x) > 1e-9 ||
                        Math.abs(a[i].tail.y - b[i].tail.y) > 1e-9
                    ) {
                        throw new Error(
                            `${granularity} ${position}: dragon ${a[i].id} differs between window and round`,
                        );
                    }
                }
            }
        }
    }
});

// Event steps inside a multi-step move stop with the head mid-glide by design,
// so this holds for the granularities whose steps end a turn.
test("whole-number positions show settled dragons", () => {
    for (const match of loadMatches()) {
        for (const granularity of ["round", "turn"] as const) {
            const end = match.endFor(granularity);
            for (let position = 0; position <= end; position += Math.max(1, Math.floor(end / 300))) {
                const frame = match.frameAt(position, granularity, 1);
                for (const view of frame.timeline.views(frame.tau, CELL)) {
                    if (view.dissolve !== undefined) continue;
                    for (const end of ["head", "tail"] as const) {
                        const p = view[end];
                        const offCentre =
                            Math.abs((((p.x / CELL - 0.5) % 1) + 1) % 1) + Math.abs((((p.y / CELL - 0.5) % 1) + 1) % 1);
                        if (offCentre > 1e-6 && Math.abs(offCentre - 2) > 1e-6 && Math.abs(offCentre - 1) > 1e-6) {
                            throw new Error(
                                `${granularity} position ${position}: dragon ${view.id}'s ${end} is off a cell centre at (${p.x}, ${p.y})`,
                            );
                        }
                    }
                }
            }
        }
    }
});

test("a head-on collision plays both deaths together at the point of contact", () => {
    // Dragon 0 sits in cells 3 and 2; dragon 1 in 4 and 5 steps west into its head.
    const map = tinyMap(8, 2, {}, [
        {
            team: 0,
            body: [
                [3, 0],
                [2, 0],
            ],
        },
        {
            team: 1,
            body: [
                [4, 0],
                [5, 0],
            ],
        },
    ]);
    const collision: GameEvent[] = [
        { type: "roundStart", round: 0 },
        { type: "turnStart", id: 1 },
        { type: "dragonAction", id: 1, action: { kind: "move", steps: ["W"] } },
        { type: "dragonDeath", id: 0, reason: DragonDeathReason.HitHeadToHead },
        { type: "dragonDeath", id: 1, reason: DragonDeathReason.HitHeadToHead },
    ];
    const match = Match.fromMapText(map, collision);
    const timeline = match.timeline(0, 1);
    const one = timeline.dragons.get(0)!.segments.find((s) => s.kind === "die")!;
    const two = timeline.dragons.get(1)!.segments.find((s) => s.kind === "die")!;
    if (one.kind !== "die" || two.kind !== "die") throw new Error("both dragons should die");
    if (one.at.start !== two.at.start) throw new Error("the two deaths should share a window");
    if (!two.contact || two.contact.x !== 3)
        throw new Error(`attacker's contact is ${JSON.stringify(two.contact)}, expected (3,0)`);
    // Dragon 1 sits in cell 4 and bumps west into cell 3, reaching the shared
    // boundary by the end of the bump.
    const bumped = timeline.views(two.at.start + 0.3 * (two.at.end - two.at.start), CELL);
    const attacker = bumped.find((v) => v.id === 1)!;
    if (Math.abs(attacker.head.x - 4 * CELL) > 0.01) {
        throw new Error(
            `attacker's head at x=${attacker.head.x}: it should have bumped to the 3|4 boundary at ${4 * CELL}`,
        );
    }
});

test("only a head-on kill knows where the collision was", () => {
    for (const match of loadMatches()) {
        for (let r = 0; r < match.maxRound; r++) {
            for (const track of match.timeline(r, 0.35).dragons.values()) {
                for (const segment of track.segments) {
                    if (segment.kind !== "die" || segment.contact === undefined) continue;
                    if (segment.reason !== DragonDeathReason.HitHeadToHead) {
                        throw new Error(
                            `round ${r} dragon ${track.id}: death "${segment.reason}" claims a contact cell, but only the two deaths of a head-on kill state one`,
                        );
                    }
                }
            }
        }
    }
});

test("the timeline reads declared actions, and how much of each the engine played", () => {
    const map = tinyMap(8, 2, {}, [
        {
            team: 0,
            body: [
                [3, 0],
                [2, 0],
                [1, 0],
                [0, 0],
            ],
        },
        {
            team: 1,
            body: [
                [6, 1],
                [7, 1],
            ],
        },
        {
            team: 0,
            body: [
                [1, 1],
                [0, 1],
            ],
        },
    ]);
    const round: GameEvent[] = [
        { type: "roundStart", round: 0 },
        // Asks for three steps and gets all three.
        { type: "turnStart", id: 0 },
        { type: "dragonAction", id: 0, action: { kind: "move", steps: ["E", "E", "E"] } },
        { type: "dragonUpdate", id: 0, facing: "E", head: { x: 4, y: 0 }, tail: { x: 1, y: 0 } },
        { type: "dragonUpdate", id: 0, facing: "E", head: { x: 5, y: 0 }, tail: { x: 3, y: 0 } },
        { type: "dragonUpdate", id: 0, facing: "E", head: { x: 6, y: 0 }, tail: { x: 5, y: 0 } },
        // Asks for two and dies on the first, so none of it plays.
        { type: "turnStart", id: 1 },
        { type: "dragonAction", id: 1, action: { kind: "move", steps: ["W", "W"] } },
        { type: "dragonDeath", id: 1, reason: DragonDeathReason.HitOtherBody },
        // Offered nothing the rules accept.
        { type: "turnStart", id: 2 },
        { type: "dragonAction", id: 2, action: { kind: "suicide" } },
        { type: "dragonDeath", id: 2, reason: DragonDeathReason.NoValidAction },
    ];
    const timeline = Match.fromMapText(map, round).timeline(0, 1);

    const one = timeline.actions.get(0);
    if (one?.action?.kind !== "move" || one.action.steps.join("") !== "EEE") {
        throw new Error(`dragon 1 asked ${JSON.stringify(one?.action)}, expected move EEE`);
    }
    if (one.stepsTaken !== 3) throw new Error(`dragon 1 played ${one.stepsTaken} of 3 steps`);

    const two = timeline.actions.get(1);
    if (two?.action?.kind !== "move") throw new Error(`dragon 2 asked ${JSON.stringify(two?.action)}, expected a move`);
    if (two.stepsTaken !== 0) throw new Error(`dragon 2 died on its first step but played ${two.stepsTaken}`);

    const three = timeline.actions.get(2);
    if (three?.action?.kind !== "suicide")
        throw new Error(`dragon 3 asked ${JSON.stringify(three?.action)}, expected a suicide`);

    for (const [id, declared] of timeline.actions) {
        if (declared.action?.kind !== "move") continue;
        if (declared.stepsTaken > declared.action.steps.length) {
            throw new Error(
                `dragon ${id} played ${declared.stepsTaken} of only ${declared.action.steps.length} declared steps`,
            );
        }
    }
});

interface MapDragon {
    team: 0 | 1;
    /** Head first. */
    body: [number, number][];
}

function tinyMap(
    width: number,
    height: number,
    edgeOverrides: Record<number, [number, number]> = {},
    dragons: MapDragon[] = [],
): string {
    const lines = [`MAP ${width} ${height}`, `TILE_COUNT ${width * height}`];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) lines.push(`TILE ${x} ${y} 0 0`);
    const edges: string[] = [];
    for (let row = 0; row <= 2 * height; row++) {
        const columns = row % 2 === 0 ? width : width + 1;
        for (let column = 0; column < columns; column++) {
            const id = row * (width + 1) + column;
            const [type, portal] = edgeOverrides[id] ?? [0, -1];
            edges.push(`EDGE ${id} ${type} ${portal}`);
        }
    }
    lines.push(`EDGE_COUNT ${edges.length}`, ...edges, `DRAGON_COUNT ${dragons.length}`);
    for (const dragon of dragons)
        lines.push(`DRAGON ${dragon.team} ${dragon.body.length} ${dragon.body.flat().join(" ")}`);
    lines.push("END");
    return lines.join("\n") + "\n";
}
