// Live per-team stats for the sidebar, read off the actual Match/Bodies
// state rather than the replay envelope, so there is one source of truth.

import type Match from "./visualiser/Match";
import { Tile, type DragonDeathReason, type TeamId } from "./visualiser/Schema";

export interface TeamEventStats {
    lost: number;
    deaths: Record<DragonDeathReason, number>;
    sprintAttempts: number;
    splits: number;
    sonarPings: number;
}

const emptyEvents = (): TeamEventStats => ({
    lost: 0,
    deaths: { W: 0, S: 0, O: 0, H: 0, A: 0 },
    sprintAttempts: 0,
    splits: 0,
    sonarPings: 0,
});

/** Cumulative events through completed rounds; cached snapshots also support rewinding. */
export class MatchEventStatsTracker {
    #match: Match;
    #teams = new Map<number, TeamId>();
    #snapshots: Record<TeamId, TeamEventStats>[] = [{ A: emptyEvents(), B: emptyEvents() }];

    constructor(match: Match) {
        this.#match = match;
        for (const dragon of match.map.initialDragons) this.#teams.set(dragon.id, dragon.team);
    }

    statsAt(round: number): Record<TeamId, TeamEventStats> {
        const clamped = Math.max(0, Math.min(Math.floor(round), this.#match.maxRound));
        while (this.#snapshots.length <= clamped) {
            const previous = this.#snapshots[this.#snapshots.length - 1];
            const copy = (stats: TeamEventStats): TeamEventStats => ({ ...stats, deaths: { ...stats.deaths } });
            const next = { A: copy(previous.A), B: copy(previous.B) };
            for (const event of this.#match.deltaAt(this.#snapshots.length - 1)) {
                if (event.type === "dragonSplit") {
                    this.#teams.set(event.childId, event.team);
                    next[event.team].splits++;
                } else if (event.type === "dragonDeath") {
                    const team = this.#teams.get(event.id);
                    if (team) {
                        next[team].lost++;
                        next[team].deaths[event.reason]++;
                    }
                } else if (event.type === "dragonAction") {
                    const team = this.#teams.get(event.id);
                    if (team && event.action?.kind === "move" && event.action.steps.length > 1)
                        next[team].sprintAttempts++;
                } else if (event.type === "sonarPing") {
                    const team = this.#teams.get(event.senderId);
                    if (team) next[team].sonarPings++;
                }
            }
            this.#snapshots.push(next);
        }
        return this.#snapshots[clamped];
    }
}

export interface TeamRoundStats {
    /** Dragons of this team alive at this round. */
    count: number;
    /** Longest currently-alive dragon of this team, in cells. */
    maxLength: number;
    /** Sum of all currently-alive dragon lengths for this team. */
    totalLength: number;
}

export interface MatchStatsAtRound {
    teams: Record<TeamId, TeamRoundStats>;
    /** Longest this team's dragon has ever been, from round 0 through this round. */
    bestLength: Record<TeamId, number>;
    /** Pearl tiles currently on the board. */
    pearls: number;
}

/**
 * Tracks each team's best-ever length incrementally.
 *
 */
export class MatchStatsTracker {
    #match: Match;
    #cachedRound = -1;
    #bestLength: Record<TeamId, number> = { A: 0, B: 0 };

    constructor(match: Match) {
        this.#match = match;
    }

    statsAt(round: number): MatchStatsAtRound {
        const clamped = Math.max(0, Math.min(round, this.#match.maxRound));

        if (clamped < this.#cachedRound) {
            this.#cachedRound = -1;
            this.#bestLength = { A: 0, B: 0 };
        }
        for (let r = this.#cachedRound + 1; r <= clamped; r++) {
            for (const dragon of this.#match.roundAt(r).bodies.dragons.values()) {
                this.#bestLength[dragon.team] = Math.max(this.#bestLength[dragon.team], dragon.body.length);
            }
        }
        this.#cachedRound = clamped;

        const current = this.#match.roundAt(clamped);
        const teams: Record<TeamId, TeamRoundStats> = {
            A: { count: 0, maxLength: 0, totalLength: 0 },
            B: { count: 0, maxLength: 0, totalLength: 0 },
        };
        for (const dragon of current.bodies.dragons.values()) {
            const stats = teams[dragon.team];
            stats.count += 1;
            stats.maxLength = Math.max(stats.maxLength, dragon.body.length);
            stats.totalLength += dragon.body.length;
        }

        let pearls = 0;
        for (let i = 0; i < current.map.tiles.length; i++) {
            if (current.map.tiles[i] === Tile.Pearl) pearls++;
        }

        return { teams, bestLength: { ...this.#bestLength }, pearls };
    }
}
