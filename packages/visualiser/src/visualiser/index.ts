// Public API.

export {
    DIRECTION_DELTA,
    OPPOSITE,
    directionBetween,
    movePoint,
    vectorAdd,
    vectorDist,
    vectorEq,
    vectorLerp,
    vectorLength,
    vectorMultiply,
    vectorSub,
} from "./Vector";
export { wrappedDirectionBetween } from "./Vector";
export type { BoardSize, Direction, Vector } from "./Vector";
// The wire format (mirror of the engine's event.h).
export { DebugShape, EdgeTile, DragonDeathReason, Tile } from "./Schema";
export type { GameEvent, DragonAction, DragonData, SonarHitKind, TeamId } from "./Schema";

// The board: immutable StaticMap (+ .map parsing) and per-round CurrentMap.
export {
    CurrentMap,
    StaticMap,
    edgeKey,
    sameEdge,
    edgeIdToSlot,
    edgeToId,
    serializeMapText,
    dragonFacing,
    stepFrom,
} from "./Map";
export type { PearlView, Edge, PearlRespawnBounds } from "./Map";

// The dragons and their geometry.
export { Bodies, Dragon, classifyBody, layoutDragon, settledDragonViews, stepBetween } from "./Bodies";
export type { BodySegment, CellCover, DragonMotion, DragonPart, DragonTint, DragonView } from "./Bodies";

// A round compiled into tracks on its own clock.
export { default as RoundTimeline } from "./Timeline";
export type {
    DeclaredAction,
    DieSegment,
    Effect,
    PearlChange,
    Ping,
    SlideSegment,
    SlideStep,
    DragonSample,
    DragonSegment,
    DragonTrack,
    Window,
} from "./Timeline";

// Rounds, matches, games.
export { default as Round } from "./Round";
export { default as Match } from "./Match";
export type { Granularity, TimelineFrame } from "./Match";
export { default as Game, Team } from "./Game";
// Skins: board look and dragon look.
export {
    createPixelMapSkin,
    createPixelDragonSkin,
    createSpriteMapSkin,
    createSpriteDragonSkin,
    edgeBar,
    edgeSegment,
    pixelMapSkin,
    pixelDragonSkin,
    resolveDragonSkin,
    tintColor,
    traceRounded,
    withTint,
} from "./Skins";
export type {
    CornerWarpOptions,
    MapSkin,
    MapSkinOptions,
    PerTeamDragonSkins,
    SkinContext,
    DragonSkin,
    DragonSkinOptions,
    DragonSpritePart,
    SpriteMapPart,
    SpriteMapSkinOptions,
    SpriteRef,
    SpriteDragonSkinOptions,
    StraightScrollOptions,
    TeamDragonSkin,
    TeamStyle,
    TileSize,
} from "./Skins";

// Rendering and playback.
export { default as GameRenderer, MAX_ZOOM } from "./GameRenderer";
export type { DebugDraw, Overlay } from "./GameRenderer";
export { default as GameRunner } from "./GameRunner.svelte";
export { DEFAULT_SPEED, DEFAULT_STAGGER, STAGGERED_TURNS } from "./constants";

// The board components. BoardStage is the one to reach for: it is BoardView
// plus the hover tooltip and the pinnable entity windows. BoardView alone is
// for hosts that draw their own layers over it.
export { default as BoardStage } from "./BoardStage.svelte";
export { default as BoardView } from "./BoardView.svelte";
export * from "./Entities";
export * from "./describeEntity";
export { PearlClock, NO_PEARL_DUE } from "./PearlClock";
export { DragonAges, UNBORN_AGE } from "./DragonAges";
export { default as PlaybackControls } from "./PlaybackControls.svelte";
export type { VisualiserOptions } from "./VisualiserOptions";
