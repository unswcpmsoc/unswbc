// How old each dragon is, and whether it is still alive.
//
// Nothing in the replay records a birth or a death, so both are read off the
// rounds an id appears in: the first is its birth, and once it stops appearing
// the last one is its death. Scanned forward and cached the same way the pearl
// clock is, since a hover must not walk the whole match.

import type Match from "./Match";

/** What a dragon that has not appeared yet reports instead of an age. */
export const UNBORN_AGE = -1;

export class DragonAges {
    #match: Match;
    #cachedRound = -1;
    #firstSeen = new Map<number, number>();
    #lastSeen = new Map<number, number>();

    constructor(match: Match) {
        this.#match = match;
    }

    #advanceTo(round: number): void {
        if (round < this.#cachedRound) {
            this.#cachedRound = -1;
            this.#firstSeen.clear();
            this.#lastSeen.clear();
        }
        for (let r = this.#cachedRound + 1; r <= round; r++) {
            for (const dragon of this.#match.roundAt(r).bodies.dragons.values()) {
                if (!this.#firstSeen.has(dragon.id)) this.#firstSeen.set(dragon.id, r);
                this.#lastSeen.set(dragon.id, r);
            }
        }
        this.#cachedRound = round;
    }

    #clamp(round: number): number {
        return Math.max(0, Math.min(round, this.#match.maxRound));
    }

    alive(dragonId: number, round: number): boolean {
        const clamped = this.#clamp(round);
        this.#advanceTo(clamped);
        return this.#lastSeen.get(dragonId) === clamped;
    }

    /**
     * Rounds lived by `round`. A dragon that has not appeared yet is `UNBORN_AGE`;
     * one that has died holds the age it reached.
     */
    ageAt(dragonId: number, round: number): number {
        const clamped = this.#clamp(round);
        this.#advanceTo(clamped);
        const born = this.#firstSeen.get(dragonId);
        if (born === undefined) return UNBORN_AGE;
        return this.#lastSeen.get(dragonId)! - born;
    }
}
