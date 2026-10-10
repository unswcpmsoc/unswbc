// One round's mutable state: map + bodies.

import { Bodies } from "./Bodies";
import { CurrentMap } from "./Map";
import type { GameEvent } from "./Schema";

export default class Round {
    constructor(
        public roundNumber: number,
        public map: CurrentMap,
        public bodies: Bodies,
    ) {}

    /**
     * Apply events without advancing the round number.
     */
    applyEvents(events: GameEvent[]): void {
        for (const event of events) {
            this.map.applyEvent(event);
            this.bodies.applyEvent(event);
        }
    }

    /** Apply one round's events, forwarding each to the half of the state it owns. */
    applyDelta(events: GameEvent[]): void {
        this.applyEvents(events);
        this.roundNumber += 1;
    }

    copy(): Round {
        return new Round(this.roundNumber, this.map.copy(), this.bodies.copy());
    }
}
