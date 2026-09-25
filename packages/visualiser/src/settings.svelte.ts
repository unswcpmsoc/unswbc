// App-wide skin preferences, persisted to localStorage.

import { DEFAULT_MAP_SKIN, DEFAULT_TEAM_SKINS } from "./skins/defaults";
import { mapSkins, skinColor, teamDragonSkins } from "./skins/index";
import { DEFAULT_SPEED } from "./visualiser/constants";
import type { Granularity } from "./visualiser/Match";
import type { TeamId } from "./visualiser/Schema";

/** Events that can be marked on the timeline. */
export const MARKER_KINDS = ["death", "split", "engine", "bot"] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

const GRANULARITIES: Granularity[] = ["round", "turn", "event"];

const STORAGE_KEY = "battledragon-visualiser:settings";

interface StoredSettings {
    mapSkinName: string;
    teamASkinName: string;
    teamBSkinName: string;
    /** Show every bot status indicator instead of only selected dragons. */
    showAllIndicators: boolean;
    /** Remove unrelated log rows while one or more dragons are selected. */
    hideUnselectedLogs: boolean;
    /** Playback speed and step, carried from one replay to the next. */
    speed: number;
    granularity: Granularity;
    /** Which events get a tick on the timeline. */
    markerKinds: MarkerKind[];
}

const defaults = (): StoredSettings => ({
    mapSkinName: DEFAULT_MAP_SKIN,
    teamASkinName: DEFAULT_TEAM_SKINS.A,
    teamBSkinName: DEFAULT_TEAM_SKINS.B,
    showAllIndicators: false,
    hideUnselectedLogs: false,
    speed: DEFAULT_SPEED,
    granularity: "round",
    markerKinds: ["death", "split", "engine"],
});

function load(): StoredSettings {
    if (typeof localStorage === "undefined") {
        return defaults();
    }
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) throw new Error("no stored settings");
        const parsed = JSON.parse(raw);
        return {
            mapSkinName: mapSkins.names.includes(parsed.mapSkinName) ? parsed.mapSkinName : DEFAULT_MAP_SKIN,
            teamASkinName: teamDragonSkins.names.includes(parsed.teamASkinName)
                ? parsed.teamASkinName
                : DEFAULT_TEAM_SKINS.A,
            teamBSkinName: teamDragonSkins.names.includes(parsed.teamBSkinName)
                ? parsed.teamBSkinName
                : DEFAULT_TEAM_SKINS.B,
            showAllIndicators: parsed.showAllIndicators === true,
            hideUnselectedLogs: parsed.hideUnselectedLogs === true,
            speed: typeof parsed.speed === "number" && parsed.speed > 0 ? parsed.speed : DEFAULT_SPEED,
            granularity: GRANULARITIES.includes(parsed.granularity) ? parsed.granularity : "round",
            markerKinds: Array.isArray(parsed.markerKinds)
                ? parsed.markerKinds.filter((kind: MarkerKind) => MARKER_KINDS.includes(kind))
                : defaults().markerKinds,
        };
    } catch {
        return defaults();
    }
}

const initial = load();

/** Reactive app settings. Mutate fields directly; changes persist automatically. */
export const settings = $state<StoredSettings>(initial);

export function persistSettings(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * The colour that stands for a team: the creature it played in a battle, or
 * the one the viewer is drawing it as when the replay came from disk and
 * carries no skin of its own. Falls back to the team's A/B colour.
 */
export function teamColor(team: { id: TeamId; color: string; skin?: string }): string {
    const chosen = team.id === "A" ? settings.teamASkinName : settings.teamBSkinName;
    return skinColor(team.skin ?? chosen) ?? team.color;
}
