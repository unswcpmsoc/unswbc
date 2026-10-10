// The currently-loaded replay.

import GameRunner from "./visualiser/GameRunner.svelte";
import type { OpenedReplay } from "./replay/opened";
import { MatchStatsTracker } from "./matchStats";

interface ReplayState {
    opened?: OpenedReplay;
    runner?: GameRunner;
    /** Caches best-length-ever per team; lives here for the same reason. */
    statsTracker?: MatchStatsTracker;
}

export const replayState = $state<ReplayState>({});

export function setOpenedReplay(opened: OpenedReplay): void {
    replayState.opened = opened;
    replayState.runner = new GameRunner(opened.loaded.match);
    replayState.statsTracker = new MatchStatsTracker(opened.loaded.match);
}
