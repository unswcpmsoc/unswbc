import { fetchReplaySource, readResponseBytes, type ByteProgress } from "./source.ts";
import { ReplayError } from "./errors.ts";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

Deno.test("readResponseBytes reports each chunk against Content-Length", async () => {
    const seen: ByteProgress[] = [];
    const bytes = await readResponseBytes(
        new Response(streamOf(new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])), {
            headers: { "content-length": "8" },
        }),
        (progress) => seen.push({ ...progress }),
    );

    if (bytes.length !== 8 || [...bytes].join(",") !== "1,2,3,4,5,6,7,8") {
        throw new Error(`assembled ${[...bytes]}`);
    }
    if (seen.length < 2) throw new Error(`expected a report per chunk, got ${JSON.stringify(seen)}`);
    if (seen[0].loaded !== 4 || seen[0].total !== 8) {
        throw new Error(`first report ${JSON.stringify(seen[0])}`);
    }
    const last = seen[seen.length - 1];
    if (last.loaded !== 8 || last.total !== 8) throw new Error(`final report ${JSON.stringify(last)}`);
});

Deno.test("a gzipped Content-Length is treated as the wire size", async () => {
    const seen: ByteProgress[] = [];
    await readResponseBytes(
        new Response(streamOf(new Uint8Array(8)), {
            headers: { "content-length": "2", "content-encoding": "gzip" },
        }),
        (progress) => seen.push({ ...progress }),
    );
    if (seen[0].total !== 8) throw new Error(`gzip estimate should be 4× wire size, got ${JSON.stringify(seen[0])}`);
});

Deno.test("fetchReplaySource surfaces 404 as not-found", async () => {
    try {
        await fetchReplaySource("9", () => Promise.resolve(new Response(null, { status: 404 }))).load();
        throw new Error("expected a ReplayError");
    } catch (e) {
        if (!(e instanceof ReplayError) || e.kind !== "not-found") throw e;
    }
});

Deno.test("cancelling a replay download closes the stream and rejects with AbortError", async () => {
    const abort = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
        },
        cancel() {
            cancelled = true;
        },
    });
    try {
        await readResponseBytes(new Response(stream), () => abort.abort(), abort.signal);
        throw new Error("An aborted download must not return partial replay bytes");
    } catch (e) {
        if (!(e instanceof DOMException) || e.name !== "AbortError") throw e;
    }
    if (!cancelled) throw new Error("The source was left downloading");
});

Deno.test("an already cancelled replay request does not start a fetch", async () => {
    const abort = new AbortController();
    abort.abort();
    let fetched = false;
    try {
        await fetchReplaySource("9", () => {
            fetched = true;
            return Promise.resolve(new Response());
        }).load(undefined, abort.signal);
        throw new Error("Expected cancellation");
    } catch (e) {
        if (!(e instanceof DOMException) || e.name !== "AbortError") throw e;
    }
    if (fetched) throw new Error("Fetch started after cancellation");
});
