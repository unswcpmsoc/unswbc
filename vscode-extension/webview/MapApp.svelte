<script lang="ts">
    import { onMount, untrack } from "svelte";
    import { MapEditor, buildMapText, clearBoard, editorHistory, importMapText } from "@battledragon/visualiser";

    const api = acquireVsCodeApi();
    let loaded = $state(false);
    let errorMessage: string | undefined = $state();
    let lastSentText = "";

    function load(text: string) {
        try {
            if (text.trim()) importMapText(text);
            else clearBoard();
            editorHistory.revision++;
            lastSentText = buildMapText();
            loaded = true;
            errorMessage = undefined;
        } catch (e) {
            errorMessage = `That file isn't a valid map: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    $effect(() => {
        editorHistory.commits;
        editorHistory.revision;
        if (!loaded) return;
        const text = untrack(() => buildMapText());
        if (text === lastSentText) return;
        lastSentText = text;
        api.postMessage({ type: "edit", text });
    });

    onMount(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type === "map") load(event.data.text);
        };
        window.addEventListener("message", onMessage);
        api.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    });
</script>

{#if errorMessage}
    <p role="alert" class="message">{errorMessage}</p>
{/if}
{#if loaded}
    <div class="frame"><MapEditor hostOwnsFile /></div>
{:else if !errorMessage}
    <p class="message loading">Opening map…</p>
{/if}

<style>
    .frame {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
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
