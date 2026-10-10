// Tunables shared across the visualiser.

/** Default playback speed, in rounds per second. */
export const DEFAULT_SPEED = 5;

/**
 * How far apart the turns of a round start, 0..1. 0 plays every turn across
 * the whole round, so continuous playback flows at a constant speed; 1 plays
 * them strictly one after another in acting order; in between they overlap
 * but keep their order. Any value above 0 makes each dragon move in a burst
 * and rest for the remainder of the round.
 */
export const DEFAULT_STAGGER = 0;

/** The overlapping-but-ordered layout offered by the control deck. */
export const STAGGERED_TURNS = 0.35;

/**
 * Corner rounding radius of the dragon spine, in cells. 0.5 makes the rounded
 * spine tangent to the edge midpoints, matching the corner warp art.
 */
export const CORNER_RADIUS = 0.5;

/** Samples per rounded corner; enough for a smooth polyline stroke. */
export const ARC_SAMPLES = 24;

/** Tint applied to dying dragons so kills read clearly. */
export const DEATH_TINT_COLOR = "#ff2d2d";
/** Amount of death tint; set to 0 to disable. */
export const DEATH_TINT_STRENGTH = 0.85;

/** How far into the cell it hit a dying head travels, in cells. */
export const CONTACT_BUMP = 0.5;
/** Share of a death's window spent on the bump before the body dissolves. */
export const CONTACT_SHARE = 0.3;
