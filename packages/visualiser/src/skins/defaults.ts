// The default skins and maps. Sprite skins build an `Image` and
// only work in the browser.

import type { DragonSkin, MapSkin } from "../visualiser/Skins";
import { mapSkins, teamDragonSkins } from "./index";

/** Board skin used when a caller doesn't choose one. Must be in `mapSkins`. */
export const DEFAULT_MAP_SKIN = "Deep Sea";

/**
 * Dragon skins used when a caller doesn't choose any — the two creatures that
 * used to be the team colours of one skin, so an unskinned board looks the way
 * it always has. Both must be in `teamDragonSkins`.
 */
export const DEFAULT_TEAM_SKINS = { A: "Loch Ness", B: "Jiaolong" } as const;

/** The default board skin, built on first use and cached by the registry. */
export const defaultMapSkin = (): MapSkin => mapSkins.get(DEFAULT_MAP_SKIN);

/** The default dragon skins, built on first use and cached by the registry. */
export const defaultDragonSkin = (): DragonSkin =>
    teamDragonSkins.getBothTeamSkins(DEFAULT_TEAM_SKINS.A, DEFAULT_TEAM_SKINS.B);
