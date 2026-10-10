import { leadLabel, resultLabel, standingsResult, verdict, type ReplayResult, type TeamInfo } from "./loader.ts";
import type { TeamId } from "../visualiser/Schema.ts";

const TEAMS: Record<TeamId, TeamInfo> = {
    A: { id: "A", name: "Sea Dragons", botId: "a", color: "#000" },
    B: { id: "B", name: "Kelp Riders", botId: "b", color: "#fff" },
};

function same(got: string | undefined, want: string | undefined) {
    if (got !== want) throw new Error(`read back as ${got}, expected ${want}`);
}

const standing = (longest: number, total: number, dragons = 1, queen = 2) => ({
    dragonCount: dragons,
    longestDragon: longest,
    totalLength: total,
    queenLength: queen,
});

const result = (over: Partial<ReplayResult>): ReplayResult => ({
    terminated: true,
    endReason: "roundLimit",
    winner: null,
    teamA: standing(9, 28),
    teamB: standing(9, 28),
    ...over,
});

Deno.test("a team wiped out is an elimination", () => {
    const wiped = result({ endReason: "teamEliminated", winner: "A", teamB: standing(0, 0, 0) });
    same(verdict(wiped), "by elimination");
    same(resultLabel(wiped, TEAMS, 87), "Sea Dragons wins by elimination in round 87");
});

Deno.test("both teams wiped out in the same round is its own draw", () => {
    const both = result({ endReason: "teamEliminated", teamA: standing(0, 0, 0), teamB: standing(0, 0, 0) });
    same(verdict(both), "both eliminated");
    same(resultLabel(both, TEAMS, 87), "Draw: both teams eliminated in round 87");
});

Deno.test("the longer queen settles the round limit", () => {
    const queen = result({ winner: "B", teamA: standing(14, 31, 2, 3), teamB: standing(11, 40, 2, 11) });
    same(verdict(queen), "longer queen");
    same(resultLabel(queen, TEAMS), "Kelp Riders wins: longer queen, 11 to 3");
});

Deno.test("a dead queen loses to a living one", () => {
    const dead = result({ winner: "A", teamA: standing(5, 9, 2, 5), teamB: standing(14, 40, 3, 0) });
    same(verdict(dead), "other queen died");
    same(resultLabel(dead, TEAMS), "Sea Dragons wins: Kelp Riders lost their queen");
});

Deno.test("standings score queen, then longest, then total", () => {
    same(standingsResult(standing(14, 31, 2, 3), standing(11, 40, 2, 11)).winner ?? undefined, "B");
    same(standingsResult(standing(14, 31), standing(11, 40)).winner ?? undefined, "A");
    same(standingsResult(standing(9, 28), standing(9, 31)).winner ?? undefined, "B");
    same(standingsResult(standing(9, 28), standing(9, 28)).winner ?? undefined, undefined);
    same(standingsResult(standing(9, 28), standing(0, 0, 0, 0)).endReason, "teamEliminated");
});

Deno.test("the lead reads like the result", () => {
    same(
        leadLabel(standingsResult(standing(14, 31, 2, 3), standing(11, 40, 2, 11)), TEAMS),
        "Kelp Riders leads: longer queen, 11 to 3",
    );
    same(leadLabel(standingsResult(standing(9, 28), standing(9, 28)), TEAMS), "Level");
});

Deno.test("the longest dragon settles the round limit once the queens tie", () => {
    const longest = result({ winner: "A", teamA: standing(14, 31), teamB: standing(11, 40) });
    same(verdict(longest), "longest dragon");
    same(resultLabel(longest, TEAMS), "Sea Dragons wins: longest dragon, 14 to 11");
});

Deno.test("total length settles it only once the longest dragons tie", () => {
    const total = result({ winner: "B", teamA: standing(9, 28), teamB: standing(9, 31) });
    same(verdict(total), "total length");
    same(resultLabel(total, TEAMS), "Kelp Riders wins: total length, 31 to 28, longest dragon tied at 9");
});

Deno.test("teams level on every count draw", () => {
    const level = result({});
    same(verdict(level), "equal length");
    same(resultLabel(level, TEAMS), "Draw: equal length, longest 9 each and 28 total");
});

Deno.test("a winner the standings don't explain claims no reason", () => {
    // An older engine, or one whose tiebreaks have moved on: say the game went
    // to length without naming a rule this replay doesn't bear out.
    const odd = result({ winner: "A", teamA: standing(9, 28), teamB: standing(12, 40) });
    same(verdict(odd), "on length");
    same(resultLabel(odd, TEAMS), "Sea Dragons wins on length");
});

Deno.test("a replay that never finished says so", () => {
    const running = result({ terminated: false });
    same(verdict(running), undefined);
    same(resultLabel(running, TEAMS), "Unfinished");
});
