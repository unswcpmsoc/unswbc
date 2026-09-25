import type { LoadedReplay } from "./loader";

/** A replay plus where it came from. Apps supply their own open/save. */
export interface OpenedReplay {
    loaded: LoadedReplay;
    raw: Uint8Array;
    /** File name, for display and as the default when saving back out. */
    path: string;
}
