// Skin registry. To add one: export a factory from skinList.ts and add a line
// to the relevant registry below.

import {
    pixelMapSkin,
    pixelDragonSkin,
    type MapSkin,
    type PerTeamDragonSkins,
    type TeamDragonSkin,
} from "../visualiser/Skins";
import { createDeepSeaBoardSkin, createJiaolongSkin, createLochNessSkin, createVatulelePrawnSkin } from "./skinList";

export interface SkinRegistry<T> {
    /** Names in registration order — drive skin dropdowns off this. */
    readonly names: string[];
    /** Lazily construct (once) and return the named skin. */
    get(name: string): T;
}

/** A dragon-skin registry with a helper for the "one skin per team" case. */
export interface TeamSkinRegistry extends SkinRegistry<TeamDragonSkin> {
    /** Two named skins as the `{ teamA, teamB }` pair the Visualiser accepts. */
    getBothTeamSkins(nameA: string, nameB: string): PerTeamDragonSkins;
}

function defineSkins<T>(
    factories: Record<string, () => T>,
    /**
     * Asset-free vector skin handed back during SSR and for unregistered
     * names. Kept separate from the registry so the *default* skin (below) can
     * be a sprite skin, and so neither depends on registration order.
     */
    standIn: () => T,
): SkinRegistry<T> {
    const cache = new Map<string, T>();
    const names = Object.keys(factories);
    // Not a legal skin name, so it can never collide with a registered one.
    const STAND_IN = "\0stand-in";
    const build = (key: string, make: () => T): T => {
        let skin = cache.get(key);
        if (skin === undefined) {
            skin = make();
            cache.set(key, skin);
        }
        return skin;
    };
    return {
        names,
        get(name) {
            // Sprite factories construct an `Image`, which doesn't exist on the
            // server — and nothing is drawn there anyway.
            if (typeof document === "undefined") return build(STAND_IN, standIn);
            const make = factories[name];
            return make ? build(name, make) : build(STAND_IN, standIn);
        },
    };
}

function defineTeamSkins(
    factories: Record<string, () => TeamDragonSkin>,
    standIn: () => TeamDragonSkin,
): TeamSkinRegistry {
    const base = defineSkins(factories, standIn);
    return {
        ...base,
        getBothTeamSkins: (nameA, nameB) => ({ teamA: base.get(nameA), teamB: base.get(nameB) }),
    };
}

/** All board looks, in dropdown order. */
export const mapSkins: SkinRegistry<MapSkin> = defineSkins(
    {
        "Deep Sea": createDeepSeaBoardSkin,
    },
    () => pixelMapSkin,
);

/**
 * All dragon looks, in dropdown order; each team picks one independently.
 *
 * These names are what the site stores on a team and resolves clashes over —
 * they have to stay in step with `SKIN_NAMES` in the site's `$lib/skins`. A
 * name with no entry here falls back to the vector stand-in rather than failing.
 */
export const teamDragonSkins: TeamSkinRegistry = defineTeamSkins(
    {
        Jiaolong: createJiaolongSkin,
        "Loch Ness": createLochNessSkin,
        "Vatulele Prawn": createVatulelePrawnSkin,
    },
    () => pixelDragonSkin,
);

// The factories are also exported for pages that always want one specific skin.
export { createDeepSeaBoardSkin, createJiaolongSkin, createLochNessSkin, createVatulelePrawnSkin } from "./skinList";
export { SKIN_COLORS, skinColor } from "./skinList";
