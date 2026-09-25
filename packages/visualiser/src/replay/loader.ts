// Turns replay bytes into a Match the Visualiser can play. The wire format is
// engine/replay.capnp: the map text, the two bot paths, the engine's flat
// event stream and its GameResult.

import * as capnp from "capnp-es";
import Match from "../visualiser/Match";
import type { GameEvent, TeamId } from "../visualiser/Schema";
import { ReplayError } from "./errors";
import { fetchReplaySource, fileDropReplaySource, type ByteProgress } from "./source";
import {
    GameEndReason as CapnpGameEndReason,
    Replay as CapnpReplay,
    REPLAY_FORMAT_VERSION,
    TeamStanding as CapnpTeamStanding,
} from "./generated/replay";
import { gameEventFromCapnp, teamIdFromCapnp } from "./capnpCodec";

export interface TeamInfo {
    id: TeamId;
    name: string;
    /** The bot the judge ran for this team, as it was given on the command line. */
    botId: string;
    color: string;
    /**
     * The dragon skin this team played in, for replays that come with one —
     * the site sets it from the battle. A replay file carries no skin, so this
     * is absent when one is opened from disk and the viewer's own choice stands.
     */
    skin?: string;
}

export interface TeamStanding {
    dragonCount: number;
    longestDragon: number;
    totalLength: number;
}

export type GameEndReason = "teamEliminated" | "roundLimit";

/** Mirror of the engine's GameResult. */
export interface ReplayResult {
    terminated: boolean;
    endReason: GameEndReason;
    winner: TeamId | null;
    teamA: TeamStanding;
    teamB: TeamStanding;
}

export interface LoadedReplay {
    /** Ready to hand straight to `<Visualiser match={...}>`. */
    match: Match;
    teams: Record<TeamId, TeamInfo>;
    result: ReplayResult;
    /** The raw pieces the match was built from, for rewriting the replay. */
    events: GameEvent[];
    map: string;
}

/**
 * Which of the engine's endings this was, in a couple of words: the reason a
 * game ended, not who it went to. The round limit is scored on the longest
 * dragon and only then on total length (engine/src/scoring.cc), so the two are
 * named apart rather than both called length.
 *
 * Read back off the standings rather than trusted: a replay whose numbers
 * don't account for its winner says only that length decided it.
 */
export function verdict(result: ReplayResult): string | undefined {
    if (!result.terminated) return undefined;
    if (result.endReason === "teamEliminated") return result.winner ? "by elimination" : "both eliminated";

    const { teamA: a, teamB: b } = result;
    if (!result.winner)
        return a.longestDragon === b.longestDragon && a.totalLength === b.totalLength ? "equal length" : "on length";
    const [won, lost] = result.winner === "A" ? [a, b] : [b, a];
    if (won.longestDragon > lost.longestDragon) return "longest dragon";
    if (won.longestDragon === lost.longestDragon && won.totalLength > lost.totalLength) return "total length";
    return "on length";
}

/**
 * How a match ended, in one line: "Sea Dragons wins: longest dragon, 14 to 11".
 * Lives here rather than in either app so both word a result the same way.
 * `rounds` is the last round played, which only the two endings that turn on a
 * round mention.
 */
export function resultLabel(result: ReplayResult, teams: Record<TeamId, TeamInfo>, rounds?: number): string {
    const how = verdict(result);
    if (!how) return "Unfinished";

    const { teamA: a, teamB: b } = result;
    const at = rounds === undefined ? "" : ` in round ${rounds}`;
    if (!result.winner) {
        if (how === "both eliminated") return `Draw: both teams eliminated${at}`;
        if (how === "equal length")
            return `Draw: equal length, longest ${a.longestDragon} each and ${a.totalLength} total`;
        return "Draw";
    }

    const name = teams[result.winner].name;
    const [won, lost] = result.winner === "A" ? [a, b] : [b, a];
    if (how === "by elimination") return `${name} wins by elimination${at}`;
    if (how === "longest dragon") return `${name} wins: longest dragon, ${won.longestDragon} to ${lost.longestDragon}`;
    if (how === "total length")
        return `${name} wins: total length, ${won.totalLength} to ${lost.totalLength}, longest dragon tied at ${won.longestDragon}`;
    return `${name} wins on length`;
}

export const TEAM_COLORS: Record<TeamId, string> = { A: "#4d9996", B: "#c96540" };

/** How much of the overall load bar the download owns; the rest is decode. */
export const DOWNLOAD_SHARE = 0.75;

export type ReplayLoadPhase = "download" | "load";

/** Download then decode, as one 0–1 bar the visualiser can paint. */
export interface ReplayLoadProgress {
    phase: ReplayLoadPhase;
    /** 0–1 across both phases. */
    fraction: number;
    loadedBytes?: number;
    totalBytes?: number;
}

export function asDownloadProgress(progress: ByteProgress): ReplayLoadProgress {
    const part = progress.total && progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 0;
    return {
        phase: "download",
        fraction: DOWNLOAD_SHARE * part,
        loadedBytes: progress.loaded,
        totalBytes: progress.total,
    };
}

export function asLoadProgress(part: number, bytes?: number): ReplayLoadProgress {
    return {
        phase: "load",
        fraction: DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * Math.min(1, Math.max(0, part)),
        loadedBytes: bytes,
        totalBytes: bytes,
    };
}

/** Let the page paint between decode chunks. */
function yieldToPaint(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const YIELD_EVERY = 4096;

const END_REASON_FROM_CAPNP: Record<number, GameEndReason> = {
    [CapnpGameEndReason.TEAM_ELIMINATED]: "teamEliminated",
    [CapnpGameEndReason.ROUND_LIMIT]: "roundLimit",
};

function standingFromCapnp(s: CapnpTeamStanding): TeamStanding {
    return { dragonCount: s.dragonCount, longestDragon: s.longestDragon, totalLength: s.totalLength };
}

function teamInfo(id: TeamId, botId: string): TeamInfo {
    return { id, name: `Team ${id}`, botId, color: TEAM_COLORS[id] };
}

function decodeReplay(bytes: Uint8Array | ArrayBuffer): CapnpReplay {
    try {
        // TODO: BUG HACK SEC VULN PLEASE FIX
        const message = new capnp.Message(bytes, true);
        message._capnp.traversalLimit = bytes.byteLength * 64;
        const root = message.getRoot(CapnpReplay);
        if (root.formatVersion > REPLAY_FORMAT_VERSION) {
            throw new ReplayError(
                "schema-mismatch",
                `Replay format ${root.formatVersion} requires a newer viewer (this viewer supports up to ${REPLAY_FORMAT_VERSION}).`,
            );
        }
        return root;
    } catch (cause) {
        if (cause instanceof ReplayError) throw cause;
        throw new ReplayError("invalid", "Replay is not a valid Capn Proto message", cause);
    }
}

function replayFromRoot(root: CapnpReplay, events: GameEvent[]): LoadedReplay {
    const match = Match.fromMapText(root.map, events);
    const result = root.result;
    const endReason = END_REASON_FROM_CAPNP[result.endReason];
    if (endReason === undefined || (!result._isWinner && !result._isNoWinner)) {
        throw new ReplayError("schema-mismatch", "Replay uses an unsupported game result.");
    }
    return {
        match,
        events,
        map: root.map,
        teams: { A: teamInfo("A", root.botA), B: teamInfo("B", root.botB) },
        result: {
            terminated: result.terminated,
            endReason,
            winner: result._isWinner ? teamIdFromCapnp(result.winner) : null,
            teamA: standingFromCapnp(result.teamA),
            teamB: standingFromCapnp(result.teamB),
        },
    };
}

/** Turn raw replay bytes into a `Match`. */
export function buildReplay(bytes: Uint8Array | ArrayBuffer): LoadedReplay {
    const root = decodeReplay(bytes);
    return replayFromRoot(
        root,
        [...root.events].map((event) => gameEventFromCapnp(event, root.formatVersion)),
    );
}

/**
 * Same as `buildReplay`, but yields so a progress bar can paint while a
 * long event stream is decoded.
 */
export async function buildReplayAsync(
    bytes: Uint8Array | ArrayBuffer,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
): Promise<LoadedReplay> {
    signal?.throwIfAborted();
    const root = decodeReplay(bytes);
    const list = root.events;
    const n = list.length;
    const events: GameEvent[] = new Array(n);
    onProgress?.(0);
    for (let i = 0; i < n; i++) {
        events[i] = gameEventFromCapnp(list.get(i), root.formatVersion);
        if (n >= YIELD_EVERY && (i + 1) % YIELD_EVERY === 0) {
            onProgress?.(((i + 1) / n) * 0.85);
            await yieldToPaint();
            signal?.throwIfAborted();
        }
    }
    onProgress?.(0.85);
    if (n >= YIELD_EVERY) await yieldToPaint();
    signal?.throwIfAborted();
    const loaded = replayFromRoot(root, events);
    onProgress?.(1);
    return loaded;
}

/** Fetch and build the replay for `matchId`. Throws `ReplayError`; see errors.ts. */
export async function loadReplay(
    matchId: string,
    opts: { fetch?: typeof fetch; onProgress?: (progress: ReplayLoadProgress) => void } = {},
): Promise<LoadedReplay> {
    const bytes = await fetchReplaySource(matchId, opts.fetch).load(
        opts.onProgress && ((progress) => opts.onProgress!(asDownloadProgress(progress))),
    );
    return await buildReplayAsync(bytes, (part) => opts.onProgress?.(asLoadProgress(part, bytes.byteLength)));
}

/** Build the replay from a locally dropped/picked file. */
export async function loadReplayFromFile(file: File): Promise<LoadedReplay> {
    const bytes = await fileDropReplaySource(file).load();
    return await buildReplayAsync(bytes);
}
