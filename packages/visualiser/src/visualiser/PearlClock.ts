// The `pearlIn` a bot would have been given for a tile, rebuilt from the
// `pearlCountdown` events. Before round 0 one states each spawning tile's
// starting countdown; since the engine ticks every countdown at the top of a
// round, that tile first attempts on round `countdown - 1`. Every later one
// is emitted the round the tile attempts (spawn or blocked) and redraws it, so
//
//     nextAttemptRound = attemptRound + countdown
//
// and `pearlIn` is simply the rounds to the next attempt.

import type Match from "./Match";
import type { CurrentMap } from "./Map";
import { Tile } from "./Schema";

/** What the engine reports for a tile holding a pearl, or one that never spawns. */
export const NO_PEARL_DUE = -1;

export class PearlClock {
    #match: Match;
    #width: number;
    /** Attempt rounds per tile, ascending, plus the round the last one projects to. */
    #schedule: Map<number, number[]> | undefined;

    constructor(match: Match) {
        this.#match = match;
        this.#width = match.roundAt(0).map.width;
    }

    #schedules(): Map<number, number[]> {
        if (this.#schedule) return this.#schedule;
        const schedule = new Map<number, number[]>();
        for (const event of this.#match.initEvents) {
            if (event.type !== "pearlCountdown") continue;
            const index = event.tile.y * this.#width + event.tile.x;
            schedule.set(index, [Math.max(0, event.countdown - 1)]);
        }
        for (let r = 0; r < this.#match.maxRound; r++) {
            for (const event of this.#match.deltaAt(r)) {
                if (event.type !== "pearlCountdown") continue;
                const index = event.tile.y * this.#width + event.tile.x;
                const rounds = schedule.get(index) ?? [r];
                rounds.push(r + event.countdown);
                schedule.set(index, rounds);
            }
        }
        this.#schedule = schedule;
        return schedule;
    }

    /**
     * Rounds until this tile's next spawn attempt, matching the engine's
     * `pearlIn`. `NO_PEARL_DUE` when a pearl is already there or the tile never
     * spawns; undefined when the replay never shows the tile attempting.
     */
    pearlIn(x: number, y: number, round: number, map: CurrentMap): number | undefined {
        const index = y * map.width + x;
        //if (map.tiles[index] === Tile.Pearl) return NO_PEARL_DUE;
        if (map.staticMap.pearlRespawn[index].maxRounds === 0) return NO_PEARL_DUE;

        const rounds = this.#schedules().get(index);
        if (!rounds) return undefined;
        const next = rounds.find((attempt) => attempt > round);
        return next === undefined ? undefined : next - round;
    }
}
