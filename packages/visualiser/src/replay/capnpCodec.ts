// Converts between the generated Cap'n Proto structs and the visualiser's
// plain GameEvent objects, one to one.

import {
    DragonDeathReason,
    type DebugDraw,
    type GameEvent,
    type DragonAction,
    type SonarHitKind,
    type TeamId,
} from "../visualiser/Schema";
import type { Direction, Vector } from "../visualiser/Vector";
import { ReplayError } from "./errors";
import {
    DebugDraw as CapnpDebugDraw,
    Direction as CapnpDirection,
    Event as CapnpEvent,
    PlayerAction as CapnpPlayerAction,
    Point as CapnpPoint,
    DragonDeathReason as CapnpDragonDeathReason,
    SonarHitKind as CapnpSonarHitKind,
    Team as CapnpTeam,
} from "./generated/replay";

// Ordinal tables: index = capnp enum value.
const DIRECTIONS = ["N", "E", "S", "W"] as const satisfies readonly Direction[];
const TEAM_IDS = ["A", "B"] as const satisfies readonly TeamId[];
const DEATH_REASONS = [
    DragonDeathReason.HitWall,
    DragonDeathReason.HitSelf,
    DragonDeathReason.HitOtherBody,
    DragonDeathReason.HitHeadToHead,
    DragonDeathReason.NoValidAction,
] as const satisfies readonly DragonDeathReason[];

const SONAR_HIT_KINDS = [
    undefined,
    "empty",
    "kelp",
    "ally",
    "allyHead",
    "enemy",
    "enemyHead",
] as const satisfies readonly (SonarHitKind | undefined)[];

const SONAR_HIT_KIND_TO_CAPNP = {
    empty: CapnpSonarHitKind.EMPTY,
    kelp: CapnpSonarHitKind.KELP,
    ally: CapnpSonarHitKind.ALLY,
    allyHead: CapnpSonarHitKind.ALLY_HEAD,
    enemy: CapnpSonarHitKind.ENEMY,
    enemyHead: CapnpSonarHitKind.ENEMY_HEAD,
} satisfies Record<SonarHitKind, unknown>;

const FIRST_UINT64_SONAR_FORMAT = 2;

const DIRECTION_TO_CAPNP = {
    N: CapnpDirection.NORTH,
    E: CapnpDirection.EAST,
    S: CapnpDirection.SOUTH,
    W: CapnpDirection.WEST,
} satisfies Record<Direction, unknown>;

const TEAM_ID_TO_CAPNP = { A: CapnpTeam.A, B: CapnpTeam.B } satisfies Record<TeamId, unknown>;

const DEATH_REASON_TO_CAPNP = {
    [DragonDeathReason.HitWall]: CapnpDragonDeathReason.HIT_WALL,
    [DragonDeathReason.HitSelf]: CapnpDragonDeathReason.HIT_SELF,
    [DragonDeathReason.HitOtherBody]: CapnpDragonDeathReason.HIT_OTHER_BODY,
    [DragonDeathReason.HitHeadToHead]: CapnpDragonDeathReason.HIT_HEAD_TO_HEAD,
    [DragonDeathReason.NoValidAction]: CapnpDragonDeathReason.NO_VALID_ACTION,
} satisfies Record<DragonDeathReason, unknown>;

function decode<T>(table: readonly T[], ordinal: number, what: string): T {
    const value = table[ordinal];
    if (value === undefined) throw new ReplayError("schema-mismatch", `Unknown ${what} ordinal ${ordinal}`);
    return value;
}

export const teamIdFromCapnp = (id: number): TeamId => decode(TEAM_IDS, id, "Team");
export const teamIdToCapnp = (id: TeamId) => TEAM_ID_TO_CAPNP[id];

const directionFromCapnp = (d: number): Direction => decode(DIRECTIONS, d, "Direction");

function vectorFromCapnp(v: CapnpPoint): Vector {
    return { x: v.x, y: v.y };
}

function debugDrawFromCapnp(d: CapnpDebugDraw): DebugDraw {
    if (d.shape !== 0 && d.shape !== 1) {
        throw new ReplayError("schema-mismatch", `Unknown debug shape ${d.shape}`);
    }
    return {
        shape: d.shape as DebugDraw["shape"],
        from: vectorFromCapnp(d.from),
        to: vectorFromCapnp(d.to),
        red: d.red,
        green: d.green,
        blue: d.blue,
    };
}

function actionFromCapnp(a: CapnpPlayerAction): DragonAction {
    if (a._isMove) return { kind: "move", steps: [...a.move].map(directionFromCapnp) };
    if (a._isSplit) return { kind: "split", childSegmentCount: a.split };
    if (a._isSuicide) return { kind: "suicide" };
    throw new ReplayError("schema-mismatch", `Unknown action kind ${a.which()}`);
}

export function gameEventFromCapnp(e: CapnpEvent, formatVersion: number): GameEvent {
    switch (e.which()) {
        case CapnpEvent.ROUND_START:
            return { type: "roundStart", round: e.roundStart.round };
        case CapnpEvent.TURN_START:
            return { type: "turnStart", id: e.turnStart.id };
        case CapnpEvent.PEARL_COUNTDOWN: {
            const pc = e.pearlCountdown;
            return { type: "pearlCountdown", tile: vectorFromCapnp(pc.tile), countdown: pc.countdown };
        }
        case CapnpEvent.TILE_CHANGE: {
            const tc = e.tileChange;
            return { type: "tileChange", tile: vectorFromCapnp(tc.tile), hasPearl: tc.hasPearl };
        }
        case CapnpEvent.DRAGON_ACTION: {
            const sa = e.dragonAction;
            return {
                type: "dragonAction",
                id: sa.id,
                action: sa._hasAction() ? actionFromCapnp(sa.action) : null,
                ...(sa._hasInstructions()
                    ? { instructions: { count: Number(sa.instructions.count), exceeded: sa.instructions.exceeded } }
                    : {}),
                ...(sa.tle ? { tle: true } : {}),
            };
        }
        case CapnpEvent.ENGINE_LOG:
            return { type: "engineLog", id: e.engineLog.id, text: e.engineLog.text };
        case CapnpEvent.DRAGON_LOG:
            return { type: "dragonLog", id: e.dragonLog.id, text: e.dragonLog.text };
        case CapnpEvent.DRAGON_INDICATOR:
            return { type: "dragonIndicator", id: e.dragonIndicator.id, text: e.dragonIndicator.text };
        case CapnpEvent.DEBUG_DRAW:
            return { type: "debugDraw", id: e.debugDraw.id, draw: debugDrawFromCapnp(e.debugDraw.draw) };
        case CapnpEvent.DRAGON_UPDATE: {
            const su = e.dragonUpdate;
            return {
                type: "dragonUpdate",
                id: su.id,
                facing: directionFromCapnp(su.facing),
                head: vectorFromCapnp(su.head),
                tail: vectorFromCapnp(su.tail),
            };
        }
        case CapnpEvent.DRAGON_SPLIT: {
            const ss = e.dragonSplit;
            return {
                type: "dragonSplit",
                parentId: ss.parentId,
                childId: ss.childId,
                team: teamIdFromCapnp(ss.team),
                childFacing: directionFromCapnp(ss.childFacing),
                parentBody: [...ss.parentBody].map(vectorFromCapnp),
                childBody: [...ss.childBody].map(vectorFromCapnp),
            };
        }
        case CapnpEvent.DRAGON_DEATH:
            return {
                type: "dragonDeath",
                id: e.dragonDeath.id,
                reason: decode(DEATH_REASONS, e.dragonDeath.reason, "DragonDeathReason"),
            };
        case CapnpEvent.SONAR_PING: {
            const sp = e.sonarPing;
            if (!sp._isHitId && !sp._isNoHit) throw new ReplayError("schema-mismatch", "Unknown sonar result");
            return {
                type: "sonarPing",
                senderId: sp.senderId,
                direction: directionFromCapnp(sp.direction),
                value: formatVersion < FIRST_UINT64_SONAR_FORMAT ? BigInt(sp.value) : sp.value64,
                origin: vectorFromCapnp(sp.origin),
                end: vectorFromCapnp(sp.end),
                hitId: sp._isHitId ? sp.hitId : undefined,
                hitKind: SONAR_HIT_KINDS[sp.hitKind],
            };
        }
        default:
            throw new ReplayError("schema-mismatch", `Unknown event kind ${e.which()}`);
    }
}

function writeVector(target: CapnpPoint, v: Vector): void {
    target.x = v.x;
    target.y = v.y;
}

function writeBody(list: { get(i: number): CapnpPoint }, body: Vector[]): void {
    body.forEach((v, i) => writeVector(list.get(i), v));
}

/** Writes one GameEvent into a freshly-initialised capnp Event. */
export function gameEventToCapnp(event: GameEvent, target: CapnpEvent): void {
    switch (event.type) {
        case "roundStart":
            target._initRoundStart().round = event.round;
            return;
        case "turnStart":
            target._initTurnStart().id = event.id;
            return;
        case "pearlCountdown": {
            const pc = target._initPearlCountdown();
            writeVector(pc._initTile(), event.tile);
            pc.countdown = event.countdown;
            return;
        }
        case "tileChange": {
            const tc = target._initTileChange();
            writeVector(tc._initTile(), event.tile);
            tc.hasPearl = event.hasPearl;
            return;
        }
        case "dragonAction": {
            const sa = target._initDragonAction();
            sa.id = event.id;
            sa.tle = event.tle ?? false;
            if (event.instructions) {
                const usage = sa._initInstructions();
                usage.count = BigInt(event.instructions.count);
                usage.exceeded = event.instructions.exceeded;
            }
            if (event.action === null) return;
            const action = sa._initAction();
            if (event.action.kind === "move") {
                const steps = action._initMove(event.action.steps.length);
                event.action.steps.forEach((step, i) => steps.set(i, DIRECTION_TO_CAPNP[step]));
            } else if (event.action.kind === "split") {
                action.split = event.action.childSegmentCount;
            } else {
                action.suicide = true;
            }
            return;
        }
        case "engineLog": {
            const el = target._initEngineLog();
            el.id = event.id;
            el.text = event.text;
            return;
        }
        case "dragonLog": {
            const sl = target._initDragonLog();
            sl.id = event.id;
            sl.text = event.text;
            return;
        }
        case "dragonIndicator": {
            const si = target._initDragonIndicator();
            si.id = event.id;
            si.text = event.text;
            return;
        }
        case "debugDraw": {
            const dd = target._initDebugDraw();
            dd.id = event.id;
            const draw = dd._initDraw();
            draw.shape = event.draw.shape;
            writeVector(draw._initFrom(), event.draw.from);
            writeVector(draw._initTo(), event.draw.to);
            draw.red = event.draw.red;
            draw.green = event.draw.green;
            draw.blue = event.draw.blue;
            return;
        }
        case "dragonUpdate": {
            const su = target._initDragonUpdate();
            su.id = event.id;
            su.facing = DIRECTION_TO_CAPNP[event.facing];
            writeVector(su._initHead(), event.head);
            writeVector(su._initTail(), event.tail);
            return;
        }
        case "dragonSplit": {
            const ss = target._initDragonSplit();
            ss.parentId = event.parentId;
            ss.childId = event.childId;
            ss.team = TEAM_ID_TO_CAPNP[event.team];
            ss.childFacing = DIRECTION_TO_CAPNP[event.childFacing];
            writeBody(ss._initParentBody(event.parentBody.length), event.parentBody);
            writeBody(ss._initChildBody(event.childBody.length), event.childBody);
            return;
        }
        case "dragonDeath": {
            const sd = target._initDragonDeath();
            sd.id = event.id;
            sd.reason = DEATH_REASON_TO_CAPNP[event.reason];
            return;
        }
        case "sonarPing": {
            const sp = target._initSonarPing();
            sp.senderId = event.senderId;
            sp.direction = DIRECTION_TO_CAPNP[event.direction];
            sp.value64 = event.value;
            if (event.hitKind !== undefined) sp.hitKind = SONAR_HIT_KIND_TO_CAPNP[event.hitKind];
            writeVector(sp._initOrigin(), event.origin);
            writeVector(sp._initEnd(), event.end);
            if (event.hitId !== undefined) sp.hitId = event.hitId;
            else sp.noHit = true;
            return;
        }
    }
}
