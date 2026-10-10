<script lang="ts">
    import { onMount } from "svelte";
    import {
        GameRunner,
        ReplayError,
        ReplayInspector,
        buildReplay,
        type LoadedReplay,
    } from "@battledragon/visualiser";

    let loaded: LoadedReplay | undefined = $state();
    let runner: GameRunner | undefined = $state();
    let fileName = $state("");
    let errorMessage: string | undefined = $state();

    function describeError(e: unknown): string {
        if (e instanceof ReplayError) {
            switch (e.kind) {
                case "invalid":
                    return "That file isn't a valid replay.";
                case "schema-mismatch":
                    return "This replay requires a newer replay viewer. Update unswbc to the latest version using your package manager (pip install --upgrade unswbc, uv tool upgrade unswbc, or pipx upgrade unswbc), then run unswbc vscode and reopen this replay. Reload your editor window if it is still open.";
                case "not-found":
                    return "No replay found.";
                case "unfinished":
                    return "This match hasn't finished yet.";
                case "network":
                    return "Could not read the replay.";
            }
        }
        return `Something went wrong opening that replay: ${e instanceof Error ? e.message : String(e)}`;
    }

    function open(bytes: Uint8Array | ArrayBuffer, name: string) {
        try {
            loaded = buildReplay(bytes);
            runner = new GameRunner(loaded.match);
            fileName = name;
            errorMessage = undefined;
        } catch (e) {
            errorMessage = describeError(e);
        }
    }

    onMount(() => {
        const api = acquireVsCodeApi();
        const onMessage = async (event: MessageEvent) => {
            const message = event.data;
            if (message?.type === "error") {
                errorMessage = describeError(new Error(message.message));
                return;
            }
            if (message?.type !== "open") return;
            if (message.bytes) {
                open(new Uint8Array(message.bytes), message.name);
                return;
            }
            try {
                const response = await fetch(message.url);
                open(await response.arrayBuffer(), message.name);
            } catch (e) {
                errorMessage = describeError(e);
            }
        };
        window.addEventListener("message", onMessage);
        api.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    });
</script>

{#if errorMessage}
    <p role="alert" class="message">{errorMessage}</p>
{:else if loaded && runner}
    <!-- Scrolls only when the inspector stacks and grows past the panel. -->
    <div class="frame">
        <ReplayInspector {loaded} {runner} file={fileName} />
    </div>
{:else}
    <p class="message loading">Opening replay…</p>
{/if}

<style>
    .frame {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        padding: 0.75rem;
        overflow: auto;
    }

    .message {
        margin: 1.5rem;
        padding: 0.75rem 1rem;
        font-size: var(--vis-text-body);
        color: var(--vis-error);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
        background: var(--vis-base-200);
    }

    .message.loading {
        color: var(--vis-ink-3);
    }
</style>
