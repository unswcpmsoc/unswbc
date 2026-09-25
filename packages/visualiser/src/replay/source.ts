import { ReplayError } from "./errors";

/** Bytes assembled so far, and the size we expect when the source said. */
export interface ByteProgress {
    loaded: number;
    total?: number;
}

export interface ReplaySource {
    load(onProgress?: (progress: ByteProgress) => void, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Fetches a match's replay from the backend
 *
 */
export function fetchReplaySource(matchId: string, fetchFn: typeof fetch = fetch): ReplaySource {
    return {
        async load(onProgress, signal) {
            signal?.throwIfAborted();
            let res: Response;
            try {
                res = await fetchFn(`/api/matches/${encodeURIComponent(matchId)}/replay`, { signal });
            } catch (cause) {
                signal?.throwIfAborted();
                throw new ReplayError("network", `Network error fetching the replay for match ${matchId}`, cause);
            }

            if (res.status === 404) {
                throw new ReplayError("not-found", `No replay for match ${matchId}`);
            }
            if (res.status === 409) {
                throw new ReplayError("unfinished", `Match ${matchId} has not finished yet`);
            }
            if (!res.ok) {
                throw new ReplayError(
                    "network",
                    `Unexpected status ${res.status} fetching the replay for match ${matchId}`,
                );
            }

            try {
                return await readResponseBytes(res, onProgress, signal);
            } catch (cause) {
                signal?.throwIfAborted();
                throw new ReplayError("invalid", `Could not read the replay body for match ${matchId}`, cause);
            }
        },
    };
}

/** A replay dropped or picked as a local file. */
export function fileDropReplaySource(file: File): ReplaySource {
    return {
        async load(onProgress, signal) {
            signal?.throwIfAborted();
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                signal?.throwIfAborted();
                onProgress?.({ loaded: bytes.byteLength, total: file.size || bytes.byteLength });
                return bytes;
            } catch (cause) {
                signal?.throwIfAborted();
                throw new ReplayError("invalid", `Could not read "${file.name}"`, cause);
            }
        },
    };
}

/**
 * How many decoded bytes we should expect from this response.
 *
 * Replays are stored gzipped; fetch hands us the decompressed body, so
 * `Content-Length` is the wire size. A packed replay shrinks to about a
 * quarter, matching how the store writes them.
 */
function expectedBytes(res: Response): number | undefined {
    const advertised = Number(res.headers.get("content-length"));
    if (!Number.isFinite(advertised) || advertised <= 0) return undefined;
    const encoding = res.headers.get("content-encoding") ?? "";
    if (/\bgzip\b|\bbr\b|\bdeflate\b/i.test(encoding)) return advertised * 4;
    return advertised;
}

/** Stream a response body, reporting assembled bytes as they arrive. */
export async function readResponseBytes(
    res: Response,
    onProgress?: (progress: ByteProgress) => void,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    signal?.throwIfAborted();
    let total = expectedBytes(res);
    if (!res.body) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
        return bytes;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            // Decompressed past the estimate: keep a little headroom so the bar
            // does not sit at 100% while more of the body is still arriving.
            if (total !== undefined && loaded > total) total = Math.ceil(loaded / 0.95);
            onProgress?.({ loaded, total });
        }
    } finally {
        signal?.removeEventListener("abort", abort);
        reader.releaseLock();
    }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    onProgress?.({ loaded, total: loaded });
    return bytes;
}
