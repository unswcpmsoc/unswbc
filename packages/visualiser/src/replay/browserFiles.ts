// Opening and saving replays and maps through the browser's own affordances.
// Every host is a browser now, and both apps needed the same four operations,
// so they live here instead of being written twice.
//
// A host that can do better than a file picker — a dev server that lists the
// project's files, say — layers that on top rather than replacing this.

import { buildReplayAsync, type ReplayLoadProgress, asDownloadProgress, asLoadProgress } from "./loader";
import type { OpenedReplay } from "./opened";
import { fileDropReplaySource } from "./source";

/** A map file plus where it came from. */
export interface OpenedMap {
    text: string;
    path: string;
}

/** Prompts for one file. Resolves null if the user cancels. */
export function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
        input.addEventListener("cancel", () => resolve(null));
        input.click();
    });
}

/** Hands `bytes` to the browser as a download. */
export function downloadFile(bytes: BlobPart, suggestedName: string): void {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    URL.revokeObjectURL(url);
}

/** Rejects with a `ReplayError` if the file is not a valid replay. */
export async function openReplayViaPicker(
    onProgress?: (p: ReplayLoadProgress) => void,
    signal?: AbortSignal,
): Promise<OpenedReplay | null> {
    const file = await pickFile(".replay");
    if (!file) return null;
    const raw = await fileDropReplaySource(file).load((p) => onProgress?.(asDownloadProgress(p)), signal);
    return {
        loaded: await buildReplayAsync(raw, (p) => onProgress?.(asLoadProgress(p, raw.byteLength)), signal),
        raw,
        path: file.name,
    };
}

export async function openMapViaPicker(): Promise<OpenedMap | null> {
    const file = await pickFile(".map,.txt");
    if (!file) return null;
    return { text: await file.text(), path: file.name };
}

/** Saves `raw` verbatim — a copy of what was loaded, not a re-serialization. */
export function saveReplayAs(raw: Uint8Array, suggestedName = "replay.replay"): void {
    // Blob's typings reject a possibly-SharedArrayBuffer-backed view; slice()
    // gives a fresh ArrayBuffer-backed copy, so the cast is a fact not a hope.
    downloadFile(raw.slice().buffer as ArrayBuffer, suggestedName);
}

export function saveMapAs(text: string, suggestedName = "map.map"): void {
    downloadFile(text, suggestedName);
}
