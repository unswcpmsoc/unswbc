// Writes replay files in the judge's format: the judge writes them for real,
// and the server rewrites them when it strips bot output.

import * as capnp from "capnp-es";
import type { GameEvent } from "../visualiser/Schema";
import { gameEventToCapnp, teamIdToCapnp } from "./capnpCodec";
import {
    GameEndReason as CapnpGameEndReason,
    Replay as CapnpReplay,
    REPLAY_FORMAT_VERSION,
    TeamStanding as CapnpTeamStanding,
} from "./generated/replay";
import type { ReplayResult, TeamStanding } from "./loader";

export interface ReplayInput {
    /** Literal .map file text. */
    map: string;
    botA: string;
    botB: string;
    /** The engine's flat event stream. */
    events: GameEvent[];
    result: ReplayResult;
}

const END_REASON_TO_CAPNP = {
    teamEliminated: CapnpGameEndReason.TEAM_ELIMINATED,
    roundLimit: CapnpGameEndReason.ROUND_LIMIT,
} satisfies Record<ReplayResult["endReason"], unknown>;

// capnp-es starts a message in a 4KB segment and grows it by 4KB at a time,
// copying everything written so far on each growth. A game that runs long
// enough to reach hundreds of thousands of events then spends nearly all of
// the write in memcpy, so the arena starts at roughly the finished size.
// Guessing high only holds some memory for the length of the call, since the
// segment is serialised up to the last byte written, not its capacity;
// guessing low is merely slow, because capnp still grows the segment.
const BYTES_PER_EVENT = 128;

function arenaBytes({ map, botA, botB, events }: ReplayInput): number {
    let bytes = 4096 + map.length + botA.length + botB.length;
    for (const event of events) bytes += BYTES_PER_EVENT + ("text" in event ? event.text.length : 0);
    return Math.ceil(bytes / 8) * 8;
}

/**
 * An empty message with room for `bytes` of replay.
 *
 * Capnp's traversal limit is a reader's guard against a message that claims
 * more than it carries. On the way out it only caps how much we may write,
 * and a long game needs more than the default allows.
 */
function emptyMessage(bytes: number): capnp.Message {
    // Handing capnp a blank buffer gives the message a segment of our size. It
    // treats the whole buffer as already written, so the watermark goes back to
    // zero, and the root pointer takes the first word the way it would in a
    // message capnp had sized itself.
    const message = new capnp.Message(new ArrayBuffer(bytes), false, true);
    const segment = message._capnp.segments[0];
    segment.byteLength = 0;
    segment.allocate(8);
    message._capnp.traversalLimit = Number.POSITIVE_INFINITY;
    return message;
}

function writeStanding(target: CapnpTeamStanding, standing: TeamStanding): void {
    target.dragonCount = standing.dragonCount;
    target.longestDragon = standing.longestDragon;
    target.totalLength = standing.totalLength;
}

export function encodeReplay(input: ReplayInput): Uint8Array {
    const message = emptyMessage(arenaBytes(input));
    const root = message.initRoot(CapnpReplay);

    root.formatVersion = REPLAY_FORMAT_VERSION;
    root.map = input.map;
    root.botA = input.botA;
    root.botB = input.botB;

    const events = root._initEvents(input.events.length);
    input.events.forEach((event, i) => gameEventToCapnp(event, events.get(i)));

    const result = root._initResult();
    result.terminated = input.result.terminated;
    result.endReason = END_REASON_TO_CAPNP[input.result.endReason];
    if (input.result.winner === null) result.noWinner = true;
    else result.winner = teamIdToCapnp(input.result.winner);
    writeStanding(result._initTeamA(), input.result.teamA);
    writeStanding(result._initTeamB(), input.result.teamB);

    return new Uint8Array(message.toPackedArrayBuffer());
}
