// Bot output (logs, status indicators, debug drawings, and engine messages
// that quote a bot's own lines) belongs to the team that wrote it, and so does
// the name of the bot version that played. The server strips the other team's
// from a replay before handing it to anyone, so a downloaded file carries no
// more than the screen does.

import type { GameEvent, TeamId } from "../visualiser/Schema";
import { buildReplay, type LoadedReplay } from "./loader";
import { encodeReplay } from "./writer";

const BOT_OUTPUT = new Set<GameEvent["type"]>(["dragonLog", "dragonIndicator", "debugDraw", "engineLog"]);

/** `bytes` with only `keep`'s bot output, or none at all when `keep` is unset. */
export function stripBotOutput(bytes: Uint8Array | ArrayBuffer, keep: TeamId | undefined): Uint8Array {
    return strippedView(buildReplay(bytes), keep);
}

/**
 * The same, from a replay that is already decoded. All three views of one
 * replay come out of a single decode this way, which for a long game is both
 * the slowest part of the job and the part that holds the most memory.
 */
export function strippedView(replay: LoadedReplay, keep: TeamId | undefined): Uint8Array {
    const { match, result, teams, events, map } = replay;

    // Every dragon's team: the starting ones from the map, the rest from splits.
    const team = new Map<number, TeamId>();
    for (const dragon of match.roundAt(0).bodies.dragons.values()) team.set(dragon.id, dragon.team);
    for (const event of events) if (event.type === "dragonSplit") team.set(event.childId, event.team);

    return encodeReplay({
        map,
        botA: keep === "A" ? teams.A.botId : "",
        botB: keep === "B" ? teams.B.botId : "",
        events: events
            .map((event): GameEvent => {
                if (event.type === "dragonAction" && (keep === undefined || team.get(event.id) !== keep)) {
                    const { instructions, ...action } = event;
                    return action;
                }
                return event;
            })
            .filter(
                (event) =>
                    !BOT_OUTPUT.has(event.type) ||
                    (keep !== undefined && team.get((event as { id: number }).id) === keep),
            ),
        result,
    });
}
