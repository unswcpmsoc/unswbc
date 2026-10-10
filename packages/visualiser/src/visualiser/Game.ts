// Top-level container: team metadata and the match list. A single-match
// viewer can use `Match` directly.

import type Match from "./Match";
import type { TeamId } from "./Schema";

export class Team {
    constructor(
        public readonly id: TeamId,
        public readonly name: string,
    ) {}
}

export default class Game {
    public readonly matches: Match[] = [];
    public currentMatch: Match | undefined = undefined;
    /** Winner from GameFinishEvent; null until the game ends. */
    public winner: Team | null = null;
    public scores: Record<TeamId, number> = { A: 0, B: 0 };

    constructor(public readonly teams: [Team, Team] = [new Team("A", "Team A"), new Team("B", "Team B")]) {}

    get complete(): boolean {
        return this.winner !== null;
    }

    addMatch(match: Match): void {
        this.matches.push(match);
        this.currentMatch = match;
    }

    getTeamById(id: TeamId): Team {
        return id === "A" ? this.teams[0] : this.teams[1];
    }
}
