// A match on one map: the immutable StaticMap plus a delta per round, with
// each round compiled into a timeline on demand.

import { Bodies } from "./Bodies";
import { DEFAULT_STAGGER } from "./constants";
import { CurrentMap, StaticMap } from "./Map";
import Round from "./Round";
import type { GameEvent } from "./Schema";
import RoundTimeline, { type Window } from "./Timeline";

/**
 * What one step of the scrubber spans: a whole round, one dragon's turn, or
 * one timed event.
 */
export type Granularity = "round" | "turn" | "event";

/** A round's timeline and the instant on it a position resolves to. */
export interface TimelineFrame {
    round: number;
    /** 0..1 through the round. */
    tau: number;
    timeline: RoundTimeline;
    /** The step's span of the round; whole-number positions sit at its start. */
    window: Window;
}

const ROUND_WINDOW: Window = { start: 0, end: 1, firstEvent: 0 };

export default class Match {
    /** snapshots[i] is the state after i deltas; snapshots[0] is the initial state. */
    #snapshots: Round[];
    /** deltas[i] transforms round i into round i + 1. */
    #deltas: GameEvent[][];
    /** Compiled rounds, keyed `round:stagger`. */
    #timelines = new Map<string, RoundTimeline>();
    /** Cumulative step counts per granularity: offsets[r] steps precede round r. */
    #offsets = new Map<Granularity, number[]>();
    #eventOffsets: number[] | null = null;

    /** Events the engine emitted before round 0: the starting pearl countdowns. */
    public readonly initEvents: GameEvent[] = [];

    /**
     * `events` is the engine's flat stream. It is cut into rounds at each
     * `roundStart`, which is dropped; whatever precedes the first one is `initEvents`.
     */
    constructor(
        public readonly map: StaticMap,
        events: GameEvent[] = [],
    ) {
        this.#snapshots = [new Round(0, new CurrentMap(map), new Bodies(map.initialDragons))];
        this.#deltas = [];
        for (const event of events) {
            if (event.type === "roundStart") this.#deltas.push([]);
            else if (this.#deltas.length === 0) this.initEvents.push(event);
            else this.#deltas[this.#deltas.length - 1].push(event);
        }
    }

    /** Parse a `.map` file and wrap it in a match. */
    static fromMapText(text: string, events: GameEvent[] = []): Match {
        return new Match(StaticMap.fromMapText(text), events);
    }

    /** Last round number; rounds range over [0, maxRound]. */
    get maxRound(): number {
        return this.#deltas.length;
    }

    /** Events that transform round `index` into round `index + 1`. */
    deltaAt(index: number): GameEvent[] {
        return this.#deltas[index] ?? [];
    }

    /**
     * Round after `index` deltas, clamped and cached. Shared between callers,
     * so treat returned rounds as read-only.
     */
    roundAt(index: number): Round {
        const clamped = Math.max(0, Math.min(index, this.#deltas.length));
        while (this.#snapshots.length <= clamped) {
            const next = this.#snapshots[this.#snapshots.length - 1].copy();
            next.applyDelta(this.#deltas[next.roundNumber]);
            this.#snapshots.push(next);
        }
        return this.#snapshots[clamped];
    }

    /** Total events across every delta. */
    get eventCount(): number {
        const offsets = this.#eventOffsetsFor();
        return offsets[offsets.length - 1];
    }

    /**
     * Round `round` compiled with the given turn stagger. The last round is
     * used for anything past the end; an empty match compiles its initial
     * state as a still round.
     */
    timeline(round: number, stagger: number = DEFAULT_STAGGER): RoundTimeline {
        const r = Math.max(0, Math.min(round, this.maxRound - 1));
        const key = `${r}:${stagger}`;
        let hit = this.#timelines.get(key);
        if (!hit) {
            hit = new RoundTimeline(r, this.roundAt(r), this.roundAt(r + 1), this.deltaAt(r), stagger);
            this.#timelines.set(key, hit);
        }
        return hit;
    }

    // Positions
    //
    // A position is a float step index in a granularity. Each round
    // contributes one or more windows on its clock: one for the whole round,
    // one per turn, or one per timed event. Turn and event windows come from
    // the round laid out strictly in acting order, so stepping lands on
    // settled states.

    #windows(round: number, granularity: Granularity): Window[] {
        if (granularity === "round") return [ROUND_WINDOW];
        const sequential = this.timeline(round, 1);
        return granularity === "turn" ? sequential.turns : sequential.slots;
    }

    #offsetsFor(granularity: Granularity): number[] {
        let hit = this.#offsets.get(granularity);
        if (hit) return hit;
        hit = [0];
        for (let r = 0; r < this.maxRound; r++) hit.push(hit[r] + this.#windows(r, granularity).length);
        this.#offsets.set(granularity, hit);
        return hit;
    }

    #eventOffsetsFor(): number[] {
        if (this.#eventOffsets) return this.#eventOffsets;
        const offsets = [0];
        for (const delta of this.#deltas) offsets.push(offsets[offsets.length - 1] + delta.length);
        this.#eventOffsets = offsets;
        return offsets;
    }

    /** Largest round whose first step is at or before `step`. */
    #roundOfStep(step: number, offsets: number[]): number {
        let lo = 0;
        let hi = this.maxRound - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (offsets[mid] <= step) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Last valid position in a granularity. */
    endFor(granularity: Granularity = "round"): number {
        const offsets = this.#offsetsFor(granularity);
        return offsets[offsets.length - 1];
    }

    /**
     * The round and instant a float `position` shows. `stagger` lays out the
     * turns when stepping by round; finer granularities always play in order.
     */
    frameAt(position: number, granularity: Granularity = "round", stagger: number = DEFAULT_STAGGER): TimelineFrame {
        const end = this.endFor(granularity);
        const pick = (round: number) =>
            granularity === "round" ? this.timeline(round, stagger) : this.timeline(round, 1);
        if (end === 0) return { round: 0, tau: 0, timeline: pick(0), window: ROUND_WINDOW };

        const pos = Math.max(0, Math.min(position, end));
        if (pos >= end) {
            const round = this.maxRound - 1;
            const windows = this.#windows(round, granularity);
            return { round, tau: 1, timeline: pick(round), window: windows[windows.length - 1] };
        }
        const step = Math.floor(pos);
        const offsets = this.#offsetsFor(granularity);
        const round = this.#roundOfStep(step, offsets);
        const window = this.#windows(round, granularity)[step - offsets[round]];
        const tau = window.start + (pos - step) * (window.end - window.start);
        return { round, tau, timeline: pick(round), window };
    }

    /** The round being shown at `position`; `maxRound` once playback has finished. */
    roundOf(position: number, granularity: Granularity = "round"): number {
        if (position >= this.endFor(granularity)) return this.maxRound;
        return this.frameAt(position, granularity).round;
    }

    /** How many events are applied at the whole-number position `position` sits in. */
    appliedEvents(position: number, granularity: Granularity = "round"): number {
        if (position >= this.endFor(granularity)) return this.eventCount;
        const frame = this.frameAt(Math.floor(Math.max(0, position)), granularity);
        return this.#eventOffsetsFor()[frame.round] + frame.window.firstEvent;
    }

    /** Smallest position in `granularity` at which global event `index` has been applied. */
    stepShowing(index: number, granularity: Granularity = "round"): number {
        const end = this.endFor(granularity);
        if (this.eventCount === 0) return 0;
        const clamped = Math.max(0, Math.min(index, this.eventCount - 1));
        const eventOffsets = this.#eventOffsetsFor();
        let round = 0;
        while (round + 1 < this.maxRound && eventOffsets[round + 1] <= clamped) round++;
        const local = clamped - eventOffsets[round];
        const windows = this.#windows(round, granularity);
        let k = 0;
        while (k + 1 < windows.length && windows[k + 1].firstEvent <= local) k++;
        return Math.min(end, this.#offsetsFor(granularity)[round] + k + 1);
    }

    /** The position in `granularity` that shows round `round` at instant `tau`. */
    positionOf(round: number, tau: number, granularity: Granularity = "round"): number {
        if (this.maxRound === 0) return 0;
        const r = Math.max(0, Math.min(round, this.maxRound - 1));
        const windows = this.#windows(r, granularity);
        let k = windows.length - 1;
        while (k > 0 && windows[k].start > tau) k--;
        const window = windows[k];
        const span = window.end - window.start;
        const f = span > 0 ? Math.max(0, Math.min(1, (tau - window.start) / span)) : 0;
        return this.#offsetsFor(granularity)[r] + k + f;
    }
}
