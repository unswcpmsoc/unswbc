// One round compiled from its events into tracks on a local clock τ ∈ [0, 1].
// Nothing is inferred from state diffs: each event says what moved, so a
// frame is a pure sample of the tracks at τ.

import { layoutDragon, type Dragon, type DragonMotion, type DragonView } from "./Bodies";
import { CONTACT_BUMP, CONTACT_SHARE, DEATH_TINT_COLOR, DEATH_TINT_STRENGTH } from "./constants";
import { stepFrom, type CurrentMap, type PearlView } from "./Map";
import type Round from "./Round";
import { DragonDeathReason, Tile, type GameEvent, type DragonAction, type TeamId } from "./Schema";
import { easeOutCubic, type Direction, type Vector } from "./Vector";

/** A span of the round's clock, and the first event (index into the round's delta) it plays. */
export interface Window {
    start: number;
    end: number;
    firstEvent: number;
}

export type DebugDraw = Extract<GameEvent, { type: "debugDraw" }>;

/**
 * What a dragon asked for this round, beside how much of it the engine played.
 * A move that hit something partway falls short of the steps it requested, and
 * a rejected split plays none.
 */
export interface DeclaredAction {
    action: DragonAction | null;
    instructions?: { count: number; exceeded: boolean };
    tle?: boolean;
    stepsTaken: number;
}
export type DragonIndicator = Extract<GameEvent, { type: "dragonIndicator" }>;

/** One `dragonUpdate` within a slide: its slot and the cells the tail left, furthest first. */
export interface SlideStep {
    at: Window;
    leave: Vector[];
}

/**
 * A dragon's movement in one turn: one continuous glide through
 * `after[0..steps.length-1]`, each step on its own slot, so a multi-step move
 * rounds its corners without a break between the steps.
 */
export interface SlideSegment {
    kind: "slide";
    at: Window;
    facing: Direction;
    after: Vector[];
    steps: SlideStep[];
}

/** The child side of a `dragonSplit`. */
export interface BornSegment {
    kind: "born";
    at: Window;
    facing: Direction;
    body: Vector[];
}

/**
 * The parent side of a `dragonSplit`: cells change owner, nothing moves. Over
 * the window the whole old body fades out while parent and child fade in.
 */
export interface SplitSegment {
    kind: "split";
    at: Window;
    before: Vector[];
    after: Vector[];
    childId: number;
}

/** A `dragonDeath`, with the body exactly as it was at that event. */
export interface DieSegment {
    kind: "die";
    at: Window;
    facing: Direction;
    body: Vector[];
    reason: DragonDeathReason;
    /**
     * The partner's head in a head-on kill, which the other death states. No
     * other death says where the head was going, and none is inferred: those
     * dissolve where they stand.
     */
    contact?: Vector;
}

export type DragonSegment = SlideSegment | BornSegment | SplitSegment | DieSegment;

export interface DragonTrack {
    id: number;
    team: TeamId;
    /** State at τ = 0, when the dragon was already on the board. */
    initial?: { body: Vector[]; facing: Direction };
    segments: DragonSegment[];
}

export interface PearlChange {
    cell: Vector;
    grow: boolean;
    at: Window;
}

export interface Effect {
    at: number;
    event: DebugDraw | DragonIndicator;
}

export interface Ping {
    at: Window;
    senderId: number;
    direction: Direction;
    /**
     * Every cell the wave passes through, sender's head first, following the
     * engine's own stepping: through portals, round the wrap, stopping short
     * of kelp or on the dragon it reached.
     */
    path: Vector[];
    hitId?: number;
}

/** A dragon at one instant, before geometry. */
export interface DragonSample {
    motion: DragonMotion;
    /** When this dragon last entered a cell; later arrivals draw on top. */
    enteredAt: number;
    dying: boolean;
    /** A fading image of a body that no longer exists (the whole dragon before a split). */
    ghost?: boolean;
}

interface TurnGroup {
    first: number;
    events: GameEvent[];
}

const ROUND_WINDOW: Window = { start: 0, end: 1, firstEvent: 0 };

/** Events that take time on the clock; everything else attaches to one of these. */
function isTimed(event: GameEvent): boolean {
    return event.type === "dragonUpdate" || event.type === "dragonDeath" || event.type === "dragonSplit";
}

/** A turn runs from its `turnStart` to the next; anything before the round's first one is the pearl tick. */
function groupTurns(events: GameEvent[]): TurnGroup[] {
    const groups: TurnGroup[] = [];
    events.forEach((event, i) => {
        if (event.type === "turnStart" || groups.length === 0) groups.push({ first: i, events: [] });
        groups[groups.length - 1].events.push(event);
    });
    return groups;
}

const cellKey = (c: Vector) => `${c.x},${c.y}`;

export default class RoundTimeline {
    readonly dragons = new Map<number, DragonTrack>();
    readonly pearls: PearlChange[] = [];
    readonly effects: Effect[] = [];
    readonly pings: Ping[] = [];
    /** Declared action per dragon that acted this round, keyed by dragon id. */
    readonly actions = new Map<number, DeclaredAction>();
    /** One window per acting turn (plus the round's end, if it has events), in play order. */
    readonly turns: Window[] = [];
    /** One window per timed event, in play order; a turn with none gets one for the whole turn. */
    readonly slots: Window[] = [];

    /**
     * `start` is the state before `events`, `end` the state after. `stagger`
     * spaces the turns: 0 plays them all at once, 1 one after another.
     */
    constructor(
        readonly round: number,
        readonly start: Round,
        readonly end: Round,
        events: GameEvent[],
        readonly stagger: number,
    ) {
        for (const dragon of start.bodies.dragons.values()) {
            this.dragons.set(dragon.id, {
                id: dragon.id,
                team: dragon.team,
                initial: { body: dragon.body.map((c) => ({ ...c })), facing: dragon.facing },
                segments: [],
            });
        }

        const groups = groupTurns(events);
        if (groups.length === 0) {
            this.turns.push(ROUND_WINDOW);
            this.slots.push(ROUND_WINDOW);
            return;
        }

        // Turns share their boundary values exactly when laid end to end, so a
        // position on a boundary samples the later turn's settled start rather
        // than the earlier one a rounding error short of finishing.
        const spacing = Math.max(0, Math.min(1, stagger));
        const width = 1 / (1 + spacing * (groups.length - 1));
        const starts = groups.map((_, g) => g * spacing * width);
        const state = start.copy();
        groups.forEach((group, g) => {
            const a = starts[g];
            const b = spacing === 1 ? (g + 1 < groups.length ? starts[g + 1] : 1) : a + width;
            const turn = { start: a, end: b, firstEvent: group.first };
            this.turns.push(turn);
            this.#compileTurn(group, turn, state);
        });
    }

    #track(dragon: Dragon): DragonTrack {
        let track = this.dragons.get(dragon.id);
        if (!track) {
            track = { id: dragon.id, team: dragon.team, segments: [] };
            this.dragons.set(dragon.id, track);
        }
        return track;
    }

    #compileTurn(group: TurnGroup, turn: Window, state: Round): void {
        const { events } = group;
        // Which slot each timed event owns. The two deaths of a head-on collision
        // share one (whatever logs sit between them), so the collision and both
        // dissolves play together.
        const slotOf = new Array<number>(events.length).fill(-1);
        const slotFirst: number[] = [];
        let lastTimed = -1;
        events.forEach((event, i) => {
            if (!isTimed(event)) return;
            const previous = lastTimed >= 0 ? events[lastTimed] : undefined;
            const sharedHeadOn =
                event.type === "dragonDeath" &&
                event.reason === DragonDeathReason.HitHeadToHead &&
                previous?.type === "dragonDeath" &&
                previous.reason === DragonDeathReason.HitHeadToHead;
            slotOf[i] = sharedHeadOn ? slotOf[lastTimed] : slotFirst.length;
            if (!sharedHeadOn) slotFirst.push(i);
            lastTimed = i;
        });
        const count = Math.max(1, slotFirst.length);
        const span = (turn.end - turn.start) / count;
        const starts = Array.from({ length: count }, (_, j) => turn.start + j * span);
        const windows: Window[] = starts.map((start, j) => ({
            start,
            end: j + 1 < count ? starts[j + 1] : turn.end,
            firstEvent: group.first + (slotFirst[j] ?? 0),
        }));
        this.slots.push(...windows);

        const slotAfter = (i: number): Window => {
            for (let j = i + 1; j < events.length; j++) if (slotOf[j] >= 0) return windows[slotOf[j]];
            return slotBefore(i);
        };
        const slotBefore = (i: number): Window => {
            for (let j = i - 1; j >= 0; j--) if (slotOf[j] >= 0) return windows[slotOf[j]];
            return windows[0];
        };

        let lastDeath: { body: Vector[]; reason: DragonDeathReason } | undefined;
        events.forEach((event, i) => {
            const own = slotOf[i] >= 0 ? windows[slotOf[i]] : undefined;
            switch (event.type) {
                case "dragonAction":
                    this.actions.set(event.id, {
                        action: event.action,
                        stepsTaken: 0,
                        instructions: event.instructions,
                        tle: event.tle,
                    });
                    return;
                case "dragonUpdate": {
                    const declared = this.actions.get(event.id);
                    if (declared) declared.stepsTaken += 1;
                    const dragon = state.bodies.getById(event.id);
                    if (!dragon || !own) break;
                    const before = dragon.body.map((c) => ({ ...c }));
                    state.bodies.applyEvent(event);
                    const after = dragon.body.map((c) => ({ ...c }));
                    const popped = Math.max(0, before.length + 1 - after.length);
                    const step: SlideStep = { at: own, leave: before.slice(before.length - popped).reverse() };
                    const track = this.#track(dragon);
                    const last = track.segments[track.segments.length - 1];
                    // A further step in the same turn extends the glide rather than
                    // starting a new one, so the head runs through the shared cell.
                    if (last?.kind === "slide" && last.at.end === own.start) {
                        last.at = { ...last.at, end: own.end };
                        last.after = after;
                        last.facing = event.facing;
                        last.steps.push(step);
                    } else {
                        track.segments.push({ kind: "slide", at: own, facing: event.facing, after, steps: [step] });
                    }
                    return;
                }
                case "dragonSplit": {
                    const parent = state.bodies.getById(event.parentId);
                    const before = parent?.body.map((c) => ({ ...c })) ?? [];
                    state.bodies.applyEvent(event);
                    const child = state.bodies.getById(event.childId);
                    if (!own) break;
                    if (parent) {
                        const after = parent.body.map((c) => ({ ...c }));
                        this.#track(parent).segments.push({
                            kind: "split",
                            at: own,
                            before,
                            after,
                            childId: event.childId,
                        });
                    }
                    if (child) {
                        this.#track(child).segments.push({
                            kind: "born",
                            at: own,
                            facing: child.facing,
                            body: child.body.map((c) => ({ ...c })),
                        });
                    }
                    return;
                }
                case "dragonDeath": {
                    const dragon = state.bodies.getById(event.id);
                    if (dragon && own) {
                        const body = dragon.body.map((c) => ({ ...c }));
                        const headOn = event.reason === DragonDeathReason.HitHeadToHead;
                        const contact =
                            headOn && lastDeath?.reason === DragonDeathReason.HitHeadToHead
                                ? lastDeath.body[0]
                                : undefined;
                        this.#track(dragon).segments.push({
                            kind: "die",
                            at: own,
                            facing: dragon.facing,
                            body,
                            reason: event.reason,
                            contact,
                        });
                        lastDeath = { body, reason: event.reason };
                    }
                    state.bodies.applyEvent(event);
                    return;
                }
                case "tileChange": {
                    const cell = { ...event.tile };
                    const was = state.map.tileAt(cell.x, cell.y) === Tile.Pearl;
                    state.map.applyEvent(event);
                    if (was && !event.hasPearl) {
                        // Eaten: the pearl goes as the head arrives, which is the step after it.
                        this.pearls.push({ cell, grow: false, at: slotAfter(i) });
                    } else if (!was && event.hasPearl) {
                        // Dropped or spawned: appears with whatever just happened.
                        this.pearls.push({ cell, grow: true, at: slotBefore(i) });
                    }
                    return;
                }
                case "debugDraw":
                case "dragonIndicator":
                    this.effects.push({ at: turn.start, event });
                    return;
                case "sonarPing": {
                    // Retrace the engine's cast: one step at a time along the heading,
                    // through portals and round the wrap, until the cell it reported
                    // ending on. Kelp ends it a cell short; a dragon ends it on the hit.
                    const path: Vector[] = [{ ...event.origin }];
                    let at: Vector = event.origin;
                    const limit = state.map.width + state.map.height;
                    while (path.length <= limit && !(at.x === event.end.x && at.y === event.end.y)) {
                        const next = stepFrom(state.map, at, event.direction);
                        if (!next) break;
                        at = next;
                        path.push(at);
                    }
                    this.pings.push({
                        at: slotBefore(i),
                        senderId: event.senderId,
                        direction: event.direction,
                        path,
                        hitId: event.hitId,
                    });
                    return;
                }
                default:
                    return;
            }
        });
    }

    /** Progress through a window at τ, clamped; 1 for a degenerate window. */
    static progress(at: Window, tau: number): number {
        const span = at.end - at.start;
        return span <= 0 ? 1 : Math.max(0, Math.min(1, (tau - at.start) / span));
    }

    /**
     * Movement progress through a slide. Turns laid out across the whole round
     * keep constant speed so playback flows; staggered turns move in bursts,
     * which are eased in and out so a dragon starts and stops without a jolt.
     */
    #slideProgress(at: Window, tau: number): number {
        const p = RoundTimeline.progress(at, tau);
        return this.stagger > 0 ? p * p * (3 - 2 * p) : p;
    }

    /** The dragon's motion at τ, or undefined when it is not on the board. */
    sample(track: DragonTrack, tau: number): DragonSample | undefined {
        let body = track.initial?.body;
        let facing = track.initial?.facing ?? "E";
        let enteredAt = -1;
        const base = { id: track.id, team: track.team };

        // A segment owns the open interval after its start: at the instant it
        // begins the dragon is still in its settled pose from before, so a
        // whole-number position shows a still board.
        for (const segment of track.segments) {
            if (tau <= segment.at.start) break;
            const active = tau < segment.at.end;
            const p = RoundTimeline.progress(segment.at, tau);
            switch (segment.kind) {
                case "slide":
                    if (active) {
                        const { steps } = segment;
                        let j = steps.findIndex((step) => tau < step.at.end);
                        if (j < 0) j = steps.length - 1;
                        const moved = this.#slideProgress(steps[j].at, tau);
                        let tailToGo = (1 - moved) * steps[j].leave.length;
                        for (let later = j + 1; later < steps.length; later++) tailToGo += steps[later].leave.length;
                        return {
                            motion: {
                                ...base,
                                facing: segment.facing,
                                cells: segment.after,
                                headSteps: steps.length,
                                headProgress: j + moved,
                                leave: steps.flatMap((step) => step.leave),
                                tailToGo,
                                alpha: 1,
                                moveT: moved,
                            },
                            enteredAt: segment.at.start,
                            dying: false,
                        };
                    }
                    body = segment.after;
                    facing = segment.facing;
                    enteredAt = segment.at.start;
                    break;
                case "born":
                    body = segment.body;
                    facing = segment.facing;
                    enteredAt = segment.at.start;
                    if (active) {
                        // The child fades in with its parent as the whole old body fades out.
                        return {
                            motion: { ...base, facing, cells: body, alpha: p, moveT: 1 },
                            enteredAt,
                            dying: false,
                        };
                    }
                    break;
                case "split":
                    body = segment.after;
                    if (active) {
                        return {
                            motion: { ...base, facing, cells: body, alpha: p, moveT: 1 },
                            enteredAt,
                            dying: false,
                        };
                    }
                    break;
                case "die": {
                    if (!active) return undefined;
                    const bumping = segment.contact !== undefined;
                    const dissolveProgress = bumping ? Math.max(0, (p - CONTACT_SHARE) / (1 - CONTACT_SHARE)) : p;
                    return {
                        motion: {
                            ...base,
                            facing: segment.facing,
                            cells: segment.body,
                            contact: segment.contact,
                            contactAdvance: bumping ? CONTACT_BUMP * Math.min(1, p / CONTACT_SHARE) : undefined,
                            alpha: 1 - p,
                            tint:
                                DEATH_TINT_STRENGTH > 0
                                    ? { color: DEATH_TINT_COLOR, strength: easeOutCubic(p) * DEATH_TINT_STRENGTH }
                                    : undefined,
                            dissolve: dissolveProgress * (segment.body.length + (bumping ? 1 : 0)),
                            moveT: 1,
                        },
                        enteredAt: -2,
                        dying: true,
                    };
                }
            }
        }

        if (!body) return undefined;
        return { motion: { ...base, facing, cells: body, alpha: 1, moveT: 1 }, enteredAt, dying: false };
    }

    /** The whole pre-split body of a parent mid-split, fading out as the two new dragons fade in. */
    #splitGhost(track: DragonTrack, tau: number): DragonSample | undefined {
        for (const segment of track.segments) {
            if (segment.kind !== "split" || tau <= segment.at.start || tau >= segment.at.end) continue;
            const p = RoundTimeline.progress(segment.at, tau);
            const facing = this.sample(track, tau)?.motion.facing ?? "E";
            return {
                motion: { id: track.id, team: track.team, facing, cells: segment.before, alpha: 1 - p, moveT: 1 },
                enteredAt: -1.5,
                dying: false,
                ghost: true,
            };
        }
        return undefined;
    }

    /** Every dragon at τ, in draw order: dying first, then by when they last entered a cell. */
    samples(tau: number): DragonSample[] {
        const out: DragonSample[] = [];
        for (const track of this.dragons.values()) {
            const ghost = this.#splitGhost(track, tau);
            if (ghost) out.push(ghost);
            const sample = this.sample(track, tau);
            if (sample) out.push(sample);
        }
        out.sort((a, b) => (a.dying === b.dying ? a.enteredAt - b.enteredAt : a.dying ? -1 : 1));
        return out;
    }

    /** Drawable dragons at τ, in draw order. */
    views(tau: number, cell: number): DragonView[] {
        const map = this.end.map;
        return this.samples(tau).map((s) => ({ ...layoutDragon(s.motion, cell, map.portals, map), ghost: s.ghost }));
    }

    /** Settled cells of every living dragon at τ, for hit-testing. */
    cellsAt(tau: number): Map<number, Vector[]> {
        const out = new Map<number, Vector[]>();
        for (const s of this.samples(tau)) if (!s.dying && !s.ghost) out.set(s.motion.id, s.motion.cells);
        return out;
    }

    /** Pearls at τ: those on the board at the round's start, grown or shrunk by the changes so far. */
    pearlViews(tau: number, cell: number): PearlView[] {
        const map = this.start.map;
        const scale = new Map<string, number>();
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                if (map.tiles[y * map.width + x] === Tile.Pearl) scale.set(`${x},${y}`, 1);
            }
        }
        for (const change of this.pearls) {
            if (tau < change.at.start) continue;
            const eased = easeOutCubic(RoundTimeline.progress(change.at, tau));
            scale.set(cellKey(change.cell), change.grow ? eased : 1 - eased);
        }
        const pearls: PearlView[] = [];
        for (const [key, s] of scale) {
            if (s <= 0.01) continue;
            const [x, y] = key.split(",").map(Number);
            pearls.push({ x, y, cx: (x + 0.5) * cell, cy: (y + 0.5) * cell, scale: s });
        }
        return pearls;
    }

    /** Bot drawings and status lines whose turn has begun by τ. */
    effectsAt(tau: number): { draws: DebugDraw[]; indicators: Map<number, string> } {
        const draws: DebugDraw[] = [];
        const indicators = new Map<number, string>();
        for (const effect of this.effects) {
            if (effect.at > tau) break;
            if (effect.event.type === "debugDraw") draws.push(effect.event);
            else indicators.set(effect.event.id, effect.event.text);
        }
        return { draws, indicators };
    }
}
