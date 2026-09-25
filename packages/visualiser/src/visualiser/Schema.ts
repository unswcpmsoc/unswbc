// Wire-format mirror of the engine's event.h. Keep in sync with the C++ side.

import type { Direction, Vector } from "./Vector";

/** Cell contents; stored in `CurrentMap.tiles`. */
export const Tile = {
    Empty: 0,
    Wall: 1,
    Pearl: 2,
} as const;

/** Boundary contents; stored in `CurrentMap.hEdges`/`vEdges`. */
export const EdgeTile = {
    Empty: 0,
    Kelp: 1,
    Portal: 2,
} as const;

export type Tile = (typeof Tile)[keyof typeof Tile];
export type EdgeTile = (typeof EdgeTile)[keyof typeof EdgeTile];

export type TeamId = "A" | "B";

/** Why a dragon died; mirrors the engine's `DragonDeathReason`. */
export const DragonDeathReason = {
    HitWall: "W",
    HitSelf: "S",
    HitOtherBody: "O",
    HitHeadToHead: "H",
    NoValidAction: "A",
} as const;

export type DragonDeathReason = (typeof DragonDeathReason)[keyof typeof DragonDeathReason];

export type SonarHitKind = "empty" | "kelp" | "ally" | "allyHead" | "enemy" | "enemyHead";

export const DebugShape = {
    Line: 0,
    Dot: 1,
} as const;

export type DebugShape = (typeof DebugShape)[keyof typeof DebugShape];

/** Dragon shape in .map files; `body[0]` is the head. */
export interface DragonData {
    id: number;
    team: TeamId;
    facing: Direction;
    body: Vector[];
}

/** A bot's chosen action; `suicide` is one that offered nothing the rules accept. */
export type DragonAction =
    { kind: "move"; steps: Direction[] } | { kind: "split"; childSegmentCount: number } | { kind: "suicide" };

/** A bot-requested overlay. A dot marks `from` only. */
export interface DebugDraw {
    shape: DebugShape;
    from: Vector;
    to: Vector;
    red: number;
    green: number;
    blue: number;
}

// The engine's flat event stream. judge/docs.md has the grammar it follows.
export type GameEvent =
    | { type: "roundStart"; round: number }
    | { type: "turnStart"; id: number }
    /** A spawning tile's countdown was (re)drawn: before round 0, or when it hit zero. */
    | { type: "pearlCountdown"; tile: Vector; countdown: number }
    | { type: "tileChange"; tile: Vector; hasPearl: boolean }
    /** What the bot asked for, before the engine worked out what it cost. */
    | {
          type: "dragonAction";
          id: number;
          action: DragonAction | null;
          instructions?: { count: number; exceeded: boolean };
          tle?: boolean;
      }
    | { type: "engineLog"; id: number; text: string }
    | { type: "dragonLog"; id: number; text: string }
    /** A dragon's status line for this round, shown when a viewer hovers it. */
    | { type: "dragonIndicator"; id: number; text: string }
    | { type: "debugDraw"; id: number; draw: DebugDraw }
    | {
          type: "dragonUpdate";
          id: number;
          facing: Direction;
          /** New head cell, pushed to the front. */
          head: Vector;
          /** Tail cell after this update; retracts two cells when the step was paid for. */
          tail: Vector;
      }
    /** The parent keeps `parentBody`; the child is born with `childBody`. */
    | {
          type: "dragonSplit";
          parentId: number;
          childId: number;
          team: TeamId;
          childFacing: Direction;
          parentBody: Vector[];
          childBody: Vector[];
      }
    | { type: "dragonDeath"; id: number; reason: DragonDeathReason }
    | {
          type: "sonarPing";
          senderId: number;
          direction: Direction;
          value: bigint;
          origin: Vector;
          end: Vector;
          hitId?: number;
          hitKind?: SonarHitKind;
      };
