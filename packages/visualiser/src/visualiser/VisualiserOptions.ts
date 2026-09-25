// Toggles for the Visualiser's built-in control deck.

export interface VisualiserOptions {
    /** Timeline scrubber. Requires `runner`. Default true. */
    scrubber?: boolean;
    /** Step / play-pause buttons. Requires `runner`. Default true. */
    playback?: boolean;
    /** Speed selector. Requires `runner`. Default true. */
    speed?: boolean;
    /** Round/turn/event step-granularity selector. Requires `runner`. Default true. */
    granularity?: boolean;
    /** Turn-order selector (together, staggered, in order). Requires `runner`. Default true. */
    turnOrder?: boolean;
    /** Round counter. Requires `runner`. Default true. */
    roundCounter?: boolean;
}
