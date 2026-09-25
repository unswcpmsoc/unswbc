// The sprite-sheet skins. PNGs are imported.

import { createSpriteDragonSkin, createSpriteMapSkin, type MapSkin, type TeamDragonSkin } from "../visualiser/Skins";
import bgDeepSea from "../assets/skins/board/bg_deep_sea.png";
import seaDragons from "../assets/skins/dragon/sea_dragons.png";
import vatulelePrawn from "../assets/skins/dragon/vatulele_prawn.png";

/**
 * One row of the sea-dragon sheet, which holds a teal creature over an orange
 * one. Both rows were once the two team colours of a single skin; they are
 * separate skins now, so a team picks the creature it plays as.
 *
 * Movement is procedural: `body` scrolls the strip and `turn` bends that same
 * strip (both tile [1]) around the corner pivot, so flow reads continuously.
 * `head`/`tail` must be present — the smooth-move path rides them along the end
 * wipes.
 *
 * `speed` 1 matches the rate the wipes sweep; anything else drifts and resets
 * at each round boundary. `smoothing` on: sliding a texture with
 * nearest-neighbour shimmers.
 */
/**
 * Each creature's own colour, taken from its art, for the places that stand
 * for a team without drawing it. Keyed by the names in the site's `$lib/skins`.
 */
export const SKIN_COLORS: Record<string, string> = {
    Jiaolong: "#c96540",
    "Loch Ness": "#4d9996",
    "Vatulele Prawn": "#9b76aa",
};

/** A skin's colour, or nothing for a name with no art of its own. */
export const skinColor = (name: string | undefined | null): string | undefined =>
    name ? SKIN_COLORS[name] : undefined;

function seaDragonRow(row: number): TeamDragonSkin {
    return createSpriteDragonSkin({
        src: seaDragons,
        tile: 128,
        smoothing: true,
        sprites: { head: [0, row], body: [1, row], turn: [1, row], tail: [2, row] },
        animate: {
            scroll: { body: { speed: 1 } },
            cornerWarp: { turn: { speed: 1 } },
        },
    });
}

export function createJiaolongSkin(): TeamDragonSkin {
    return { ...seaDragonRow(1), color: SKIN_COLORS.Jiaolong };
}

export function createLochNessSkin(): TeamDragonSkin {
    return { ...seaDragonRow(0), color: SKIN_COLORS["Loch Ness"] };
}

/**
 * Four 128×128 tiles in a row — head, body, turn, tail — cut from the artist's
 * drawings and turned onto the sheet's base orientations.
 *
 * No `animate`, unlike the sea dragons: the corner here is drawn as a corner
 * rather than as a strip, and warping it around the pivot pulls the segments
 * out of shape.
 */
export function createVatulelePrawnSkin(): TeamDragonSkin {
    return createSpriteDragonSkin({
        src: vatulelePrawn,
        tile: 128,
        smoothing: true,
        sprites: { head: [0, 0], body: [1, 0], turn: [1, 0], tail: [3, 0] },
        animate: {
            scroll: { body: { speed: 1 } },
            cornerWarp: { turn: { speed: 1 } },
        },
        color: SKIN_COLORS["Vatulele Prawn"],
    });
}

/**
 * Deep sea sheet: six 128×128 tiles — floor, floor-alt, wall-edge, pearl,
 * portal, portal-accent. Tile 2 is a `wall-edge` (barrier between cells), not
 * a `wall` (blocked cell) — maps are built from edges, so filling only the
 * `wall` slot renders nothing.
 */
export function createDeepSeaBoardSkin(): MapSkin {
    return createSpriteMapSkin({
        src: bgDeepSea,
        tile: 128,
        sprites: {
            floor: [0, 0],
            "floor-alt": [1, 0],
            "wall-edge": [2, 0],
            pearl: [3, 0],
            portal: [4, 0],
            "portal-accent": [5, 0],
        },
    });
}
