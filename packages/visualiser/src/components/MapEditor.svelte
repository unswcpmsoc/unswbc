<script lang="ts">
    // The map editor page.
    import type { Snippet } from "svelte";
    import { CurrentMap } from "../visualiser/Map";
    import MapEditorCanvas from "./MapEditorCanvas.svelte";
    import { clamp } from "../visualiser/Vector";
    import {
        editor,
        buildMapText,
        importMapText,
        editorStaticMap,
        toggleBorders,
        clearBoard,
        setBoardSize,
        setSymmetry,
        cancelDragonDraft,
        removeDragon,
        dragonPairs,
        editorUi,
        fillPearls,
        commitPearlBound,
        setLayer,
        setBrush,
        MAX_SIZE,
        MIN_SIZE,
        type BrushType,
        type DrawMode,
        type Symmetry,
        type EditorLayer,
    } from "../mapEditor.svelte";
    import { editorHistory, beginEdit, endEdit, edit, undo, redo } from "../editorHistory.svelte";
    import {
        selection,
        setTool,
        selectedCount,
        copySelection,
        deleteSelection,
        startPaste,
        clearSelection,
    } from "../editorSelection.svelte";

    const selectionCount = $derived(selectedCount());

    function chooseTool(value: DrawMode | "select") {
        if (value === "select") {
            setTool("select");
            return;
        }
        setTool("paint");
        editor.drawMode = value;
    }

    let fileInput: HTMLInputElement | undefined = $state();

    // A hover left behind when the list goes away would keep the board lit.
    $effect(() => {
        if (editor.brushType !== "dragon" || selection.tool === "select") editorUi.hoveredDragons = [];
    });

    // The size fields are held as text so a number can be typed through widths
    // that are briefly out of range.
    let widthText = $state(String(editor.w));
    let heightText = $state(String(editor.h));

    /** The size this text names, or undefined if it isn't one the board can take. */
    function readSize(text: string): number | undefined {
        if (!/^\d+$/.test(text.trim())) return undefined;
        const size = Number(text);
        return size >= MIN_SIZE && size <= MAX_SIZE ? size : undefined;
    }

    const sizeIssue = $derived(
        readSize(widthText) === undefined || readSize(heightText) === undefined
            ? `Size must be between ${MIN_SIZE} and ${MAX_SIZE}. Showing the last valid board.`
            : undefined,
    );

    function setSizeText(which: "w" | "h", size: number) {
        if (which === "w") widthText = String(size);
        else heightText = String(size);
    }

    // Typing only edits the field. The board is resized on Enter or on leaving
    // it, and only once the resize is confirmed — applying every valid number
    // along the way would empty the map before the size was even settled.
    function commitSize(which: "w" | "h") {
        const text = which === "w" ? widthText : heightText;
        const digits = text.trim();
        const size = /^\d+$/.test(digits) ? clamp(Number(digits), MIN_SIZE, MAX_SIZE) : editor[which];
        if (size === editor[which]) {
            setSizeText(which, size);
            return;
        }
        const w = which === "w" ? size : editor.w;
        const h = which === "h" ? size : editor.h;
        askFirst({
            message: `Resize the board to ${w} x ${h}? Everything on the board will be cleared.`,
            confirmLabel: "Resize",
            run: () => {
                setBoardSize(which, size);
                setSizeText(which, size);
            },
            cancel: () => setSizeText(which, editor[which]),
        });
    }

    function askSymmetry(symm: Symmetry, restore: () => void) {
        if (symm === editor.symm) return;
        askFirst({
            message: `Switch symmetry to ${symm}? Everything on the board will be cleared.`,
            confirmLabel: "Switch",
            run: () => setSymmetry(symm),
            cancel: restore,
        });
    }

    // Clearing takes a second click.
    interface Ask {
        message: string;
        confirmLabel: string;
        run: () => void;
        cancel?: () => void;
    }
    let pending: Ask | undefined = $state();

    function askFirst(ask: Ask) {
        pending = ask;
    }

    function confirmPending() {
        const ask = pending;
        pending = undefined;
        if (ask) edit(ask.run);
    }

    function cancelPending() {
        const ask = pending;
        pending = undefined;
        ask?.cancel?.();
    }
    function openConfirmation(dialog: HTMLDialogElement) {
        const previous = document.activeElement;
        dialog.showModal();
        return {
            destroy() {
                dialog.close();
                if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
            },
        };
    }

    function syncSizeFields() {
        widthText = String(editor.w);
        heightText = String(editor.h);
    }

    $effect(() => {
        editor.w;
        editor.h;
        editor.symm;
        editor.layer;
        editorUi.showPearlDensity;
        editorHistory.revision;
        clearSelection();
        syncSizeFields();
    });

    // Parsed once per edit and shared: the canvas draws from it and the spawn
    // check reads its dragons.
    const parsed = $derived.by(() => {
        try {
            return { map: new CurrentMap(editorStaticMap()) };
        } catch (e) {
            return { error: e instanceof Error ? e.message : "Could not render this map." };
        }
    });

    const mapText = $derived(parsed.map ? buildMapText(parsed.map.staticMap) : "");
    const PREVIEW_LINES = 80;
    const mapPreview = $derived.by(() => {
        const lines = mapText.split("\n");
        if (lines.length <= PREVIEW_LINES) return mapText;
        const hidden = lines.length - PREVIEW_LINES;
        return lines.slice(0, PREVIEW_LINES).join("\n") + `\n... ${hidden} more lines`;
    });
    /** Spawn placements the engine would reject on load. */
    const spawnIssue = $derived.by(() => {
        const map = parsed.map?.staticMap;
        if (!map) return undefined;
        const owner = new Map<string, string>();
        for (const dragon of map.initialDragons) {
            for (const p of dragon.body) {
                if (!map.inBounds(p.x, p.y)) {
                    return `Team ${dragon.team}'s spawn runs off the board at (${p.x}, ${p.y}).`;
                }
                const key = `${p.x},${p.y}`;
                const held = owner.get(key);
                if (held === dragon.team) return `Team ${dragon.team}'s spawn doubles back onto (${p.x}, ${p.y}).`;
                if (held) return `The two spawns overlap at (${p.x}, ${p.y}).`;
                owner.set(key, dragon.team);
            }
        }
        for (const team of ["A", "B"] as const) {
            if (!map.initialDragons.some((dragon) => dragon.team === team)) return `Team ${team} has no dragons.`;
        }
        return undefined;
    });

    let importIssue: string | undefined = $state();

    async function handleImportFile() {
        const file = fileInput?.files?.[0];
        if (!file) return;
        if (fileInput) fileInput.value = "";
        importIssue = undefined;
        try {
            const text = await file.text();
            edit(() => importMapText(text));
            clearSelection();
            syncSizeFields();
        } catch (error) {
            importIssue = error instanceof Error ? error.message : "Could not import this map.";
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (pending && e.key === "Escape") {
            cancelPending();
            return;
        }
        const target = e.target as HTMLElement | null;
        if (
            pending ||
            target?.isContentEditable ||
            (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
        )
            return;
        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            if (key === "z" || key === "y") {
                e.preventDefault();
                if (key === "y" || e.shiftKey) redo();
                else undo();
                return;
            }
            if (selection.tool === "select" && ["a", "c", "x", "v"].includes(key)) {
                e.preventDefault();
                if (key === "a") selection.rectangle = { x: 0, y: 0, width: editor.w, height: editor.h };
                if (key === "c") copySelection();
                if (key === "x") copySelection(true);
                if (key === "v") startPaste();
                return;
            }
        }
        if (selection.tool === "select" && (key === "delete" || key === "backspace")) {
            e.preventDefault();
            deleteSelection();
            return;
        }
        if (e.key === "Escape") {
            cancelDragonDraft();
            editor.pendingPortal = undefined;
            clearSelection();
            return;
        }
    }

    let copyMessage = $state("");
    async function copyToClipboard() {
        try {
            await navigator.clipboard.writeText(mapText);
            copyMessage = "Map copied.";
        } catch {
            copyMessage = "Could not copy. Export the map instead.";
        }
    }

    function downloadMap() {
        const blob = new Blob([mapText], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${editor.name.trim() || "map"}.map`;
        a.click();
        URL.revokeObjectURL(a.href);
    }
    let { sidebarHeader }: { sidebarHeader?: Snippet } = $props();
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="map-editor">
    {#if pending}
        <dialog use:openConfirmation class="confirm" aria-label="Confirm map change" onclose={cancelPending}>
            <p>{pending.message}</p>
            <div class="confirm-actions">
                <button onclick={cancelPending}>Cancel</button>
                <button class="confirm-go" onclick={confirmPending}>{pending.confirmLabel}</button>
            </div>
        </dialog>
    {/if}
    <aside class="stats-panel">
        {@render sidebarHeader?.()}
        <div class="field-row">
            <button onclick={undo} disabled={!editorHistory.undo.length} title="Undo (Ctrl/Cmd+Z)">Undo</button>
            <button onclick={redo} disabled={!editorHistory.redo.length} title="Redo (Ctrl/Cmd+Shift+Z)">Redo</button>
        </div>
        {#if selection.tool === "select"}
            <div class="field-row">
                <button disabled={!selectionCount} onclick={() => copySelection()} title="Ctrl/Cmd+C">Copy</button>
                <button disabled={!selectionCount} onclick={() => copySelection(true)} title="Ctrl/Cmd+X">Cut</button>
                <button disabled={!selection.clipboard} onclick={startPaste} title="Ctrl/Cmd+V">Paste</button>
            </div>
            <div class="field-row">
                <button disabled={!selectionCount} onclick={deleteSelection}>Delete selection</button>
                <button disabled={!selection.rectangle && !selection.pasting} onclick={clearSelection}>Deselect</button>
            </div>
            <p class="hint">
                Drag to select a rectangle, then drag inside it to move. Clicking off the selection will deselect it.
                Dragons / portals can only be dragged in whole. Mirrored partners will also follow selection.
            </p>
            <details class="hint">
                <summary>Selection help</summary>
                <p>
                    Shift + arrow keys resize the selection; arrow keys moves the selection. Copy / Cut / Paste with Ctrl/Cmd + C/V/X. Ctrl + A selects the board. Escape
                    to cancel selection
                </p>
            </details>
            <p class="hint" role="status">
                {selection.message || `${selectionCount} object(s), plus mirrored partners`}
            </p>
        {/if}
        <label class="fcol">
            Map name
            <input
                type="text"
                value={editor.name}
                onfocus={beginEdit}
                onblur={endEdit}
                oninput={(e) => (editor.name = e.currentTarget.value = e.currentTarget.value.replace(/[^ -~]/g, ""))}
            />
        </label>
        <div class="field-row">
            <label>
                Width
                <input
                    type="number"
                    min={MIN_SIZE}
                    max={MAX_SIZE}
                    value={widthText}
                    oninput={(e) => (widthText = e.currentTarget.value)}
                    onblur={() => commitSize("w")}
                    onkeydown={(e) => e.key === "Enter" && commitSize("w")}
                />
            </label>
            <label>
                Height
                <input
                    type="number"
                    min={MIN_SIZE}
                    max={MAX_SIZE}
                    value={heightText}
                    oninput={(e) => (heightText = e.currentTarget.value)}
                    onblur={() => commitSize("h")}
                    onkeydown={(e) => e.key === "Enter" && commitSize("h")}
                />
            </label>
        </div>

        <p class="hint">Changing the size will clear the board.</p>
        {#if selection.tool !== "select"}
            <details class="hint">
                <summary>Keyboard drawing</summary>
                <p>
                    Focus the board and use arrow keys to move. Space paints, E switches between top and left edges,
                    Delete erases, Enter finishes a dragon, and Escape cancels a draft.
                </p>
            </details>
        {/if}

        {#if sizeIssue}
            <div class="warning">{sizeIssue}</div>
        {/if}

        <label class="fcol">
            Layer
            <select value={editor.layer} onchange={(e) => setLayer(e.currentTarget.value as EditorLayer)}>
                <option value="all">All layers</option>
                <option value="kelp">Kelp</option>
                <option value="portals">Portals</option>
                <option value="pearls">Pearl density</option>
                <option value="dragons">Dragons</option>
            </select>
        </label>

        {#if editor.layer === "all"}
            <label class="density-toggle">
                <input type="checkbox" bind:checked={editorUi.showPearlDensity} />
                Show pearl density
            </label>
        {/if}

        <label class="fcol">
            Symmetry
            <select
                value={editor.symm}
                onchange={(e) => {
                    const select = e.currentTarget;
                    askSymmetry(select.value as Symmetry, () => (select.value = editor.symm));
                }}
            >
                <option value="x">x</option>
                <option value="y">y</option>
                <option value="xy">xy</option>
            </select>
        </label>

        <label class="fcol">
            Tools
            <select
                value={selection.tool === "select" ? "select" : editor.drawMode}
                onchange={(e) => chooseTool(e.currentTarget.value as DrawMode | "select")}
            >
                <option value="draw">Draw</option>
                <option value="erase">Erase</option>
                <option value="select">Select</option>
            </select>
        </label>

        <!-- Every other layer pins the brush to what it shows, so the picker
		     would only offer a choice that isn't there to make. -->
        {#if editor.layer === "all" && selection.tool !== "select"}
            <label class="fcol">
                Brush
                <select value={editor.brushType} onchange={(e) => setBrush(e.currentTarget.value as BrushType)}>
                    <option value="kelp">Kelp</option>
                    <option value="portal">Portal</option>
                    <option value="pearl">Pearl beds</option>
                    <option value="dragon">Dragons</option>
                </select>
            </label>
        {/if}

        {#if selection.tool !== "select"}
            {#if editor.brushType === "kelp"}
                <button onclick={() => edit(toggleBorders)}>Toggle Borders</button>
                <p class="hint">
                    Click or drag along edges to lay kelp. Right-click or hold ctrl to erase. The board wraps around so
                    editing the top and left boundaries to change the bottom and right boundaries too.
                </p>
            {:else if editor.brushType === "portal"}
                <p class="hint">
                    Click two edges to define the entrance and exit of a portal pair. Both portals must be facing the
                    same way. Click a pending edge again to cancel, or right-click a portal to unglue it. If one portal
                    is on the axis of symmetry, the other must be too.
                </p>
                {#if editor.pendingPortal}
                    <div class="warning">
                        Portal {editor.portals.length} waiting for its other end.
                        <button onclick={() => (editor.pendingPortal = undefined)}>Cancel</button>
                    </div>
                {/if}
                <div class="hint">
                    {editor.portals.length} portal(s)
                </div>
            {:else if editor.brushType === "pearl"}
                <div class="field-row">
                    <label>
                        Min rounds
                        <input
                            type="number"
                            min="0"
                            bind:value={editor.pearlBrush.minRounds}
                            onblur={() => commitPearlBound("minRounds")}
                            onkeydown={(e) => e.key === "Enter" && commitPearlBound("minRounds")}
                        />
                    </label>
                    <label>
                        Max rounds
                        <input
                            type="number"
                            min="0"
                            bind:value={editor.pearlBrush.maxRounds}
                            onblur={() => commitPearlBound("maxRounds")}
                            onkeydown={(e) => e.key === "Enter" && commitPearlBound("maxRounds")}
                        />
                    </label>
                </div>
                <p class="hint">
                    Each tile waits a random number of rounds in this range, then tries to grow a pearl. [0,0] means a
                    pearl will never spawn. Right-click or ctrl-click clears a tile.
                </p>
                <div class="field-row">
                    <button onclick={() => edit(() => fillPearls())}>Fill pearls</button>
                    <button onclick={() => edit(() => fillPearls({ minRounds: 0, maxRounds: 0 }))}>Clear pearls</button>
                </div>
            {:else}
                <div class="field-row">
                    <label>
                        Team
                        <select bind:value={editor.nextDragonTeam}>
                            <option value={0}>A</option>
                            <option value={1}>B</option>
                        </select>
                    </label>
                </div>
                <p class="hint">
                    Drag from the head along the dragon and let go to add it. Escape while dragging cancels the dragon.
                    Right-click a dragon to erase it. Hold ctrl on the dragon being drawn to 'reset' to that cell.
                </p>
                <ul class="dragon-list">
                    {#each dragonPairs() as pair (pair.indices.join("-"))}
                        {@const label = pair.dragons
                            .map((dragon, i) => `${dragon.team === 0 ? "A" : "B"}${pair.indices[i]}`)
                            .join(" + ")}
                        <li
                            onpointerenter={() => (editorUi.hoveredDragons = pair.indices)}
                            onpointerleave={() => (editorUi.hoveredDragons = [])}
                            onfocusin={() => (editorUi.hoveredDragons = pair.indices)}
                            onfocusout={() => (editorUi.hoveredDragons = [])}
                        >
                            <span>{label} &middot; {pair.dragons[0].body.length} cells</span>
                            <button
                                aria-label="Remove {label}"
                                onclick={() => edit(() => removeDragon(pair.indices[0]))}>Remove</button
                            >
                        </li>
                    {/each}
                </ul>
            {/if}
        {/if}

        {#if spawnIssue}
            <div class="warning">{spawnIssue}</div>
        {/if}

        <div class="section-title">Board</div>
        <button
            onclick={() =>
                askFirst({
                    message: "Clear the board? Every wall, portal, pearl bed and dragon will be removed.",
                    confirmLabel: "Clear",
                    run: clearBoard,
                })}
        >
            Clear board
        </button>

        <div class="section-title">Map file</div>
        <div class="field-row">
            <button onclick={copyToClipboard}>Copy</button>
            <button onclick={downloadMap}>Export</button>
            <button onclick={() => fileInput?.click()}>Import</button>
            <input type="file" accept=".map,.txt" hidden bind:this={fileInput} onchange={handleImportFile} />
        </div>
        {#if importIssue}
            <div class="warning" role="alert">{importIssue}</div>
        {/if}
        {#if copyMessage}<p class="hint" role="status">{copyMessage}</p>{/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll code.) -->
        <pre class="map-preview" tabindex="0" role="region" aria-label="Map source">{mapPreview}</pre>
    </aside>

    <MapEditorCanvas map={parsed.map} error={parsed.error} />
</div>

<style>
    .map-editor {
        position: relative;
        display: flex;
        min-height: 0;
        /* The host route sizes the container; fill whatever it gives us. */
        height: 100%;
        overflow: hidden;
        background: var(--vis-base-200);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
    }

    .stats-panel {
        flex-shrink: 0;
        width: 260px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px;
        background: var(--vis-dock);
        border-right: 1px solid var(--vis-rule);
        overflow-y: auto;
    }

    .section-title {
        margin-top: 4px;
        padding-top: 6px;
        border-top: 1px solid var(--vis-rule);
        font-size: var(--vis-text-label);
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--vis-ink-3);
    }

    .fcol,
    .field-row label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--vis-text-meta);
        font-weight: 500;
        color: var(--vis-ink-2);
    }

    .field-row {
        display: flex;
        gap: 8px;
    }

    .density-toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--vis-text-meta);
        color: var(--vis-ink-2);
        cursor: pointer;
    }

    .density-toggle input {
        width: 16px;
        height: 16px;
        min-height: 0;
        padding: 0;
        margin: 0;
        accent-color: var(--vis-primary);
    }

    .field-row label {
        flex: 1;
        min-width: 0;
    }

    input,
    select {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        min-height: 28px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 400;
        color: var(--vis-ink);
        background: var(--vis-field);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
    }

    input:focus,
    select:focus {
        border-color: var(--vis-primary);
    }

    button {
        min-height: 28px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        color: var(--vis-ink);
        background: var(--vis-base-300);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        cursor: pointer;
    }

    button:hover:not(:disabled) {
        background: var(--vis-press);
    }

    button:disabled {
        cursor: not-allowed;
        color: var(--vis-ink-3);
        background: var(--vis-base-200);
    }

    .field-row button {
        flex: 1;
    }

    .hint {
        margin: 0;
        font-size: var(--vis-text-meta);
        line-height: 1.35;
        color: var(--vis-ink-3);
    }

    .warning {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        font-size: var(--vis-text-meta);
        line-height: 1.35;
        color: var(--vis-warning);
        background: var(--vis-base-200);
        border: 1px solid var(--vis-warning);
        border-radius: var(--vis-radius-box);
    }

    .warning button {
        align-self: flex-start;
    }

    .dragon-list {
        display: flex;
        flex-direction: column;
        margin: 0;
        padding: 0;
        list-style: none;
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
    }

    .dragon-list:empty {
        display: none;
    }

    .dragon-list li {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 6px 6px 6px 12px;
        font-size: var(--vis-text-meta);
        font-variant-numeric: tabular-nums;
        color: var(--vis-ink-2);
    }

    .dragon-list li + li {
        border-top: 1px solid var(--vis-rule-soft);
    }

    .dragon-list li:hover,
    .dragon-list li:focus-within {
        background: var(--vis-press);
        color: var(--vis-ink);
    }

    .dragon-list button {
        min-height: 28px;
        padding: 2px 10px;
        font-size: var(--vis-text-meta);
    }

    .map-preview {
        flex: 1;
        min-height: 56px;
        margin: 0;
        padding: 12px;
        font-family: var(--vis-font-mono);
        font-size: var(--vis-text-label);
        line-height: 1.4;
        color: var(--vis-ink-3);
        background: var(--vis-field);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
        overflow: auto;
        white-space: pre;
    }

    .confirm::backdrop {
        background: rgb(0 0 0 / 0.65);
    }

    .confirm {
        width: min(480px, calc(100vw - 32px));
        margin: auto;
        color: var(--vis-ink);
        padding: 24px;
        background: var(--vis-base-200);
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-box);
    }

    .confirm p {
        margin: 0;
        font-size: 12px;
        line-height: 1.6;
        color: var(--vis-ink-2);
    }

    .confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 24px;
    }
    .confirm-go {
        color: var(--vis-error);
        border-color: var(--vis-error);
    }

    @media (max-width: 700px) {
        .map-editor {
            flex-direction: column-reverse;
        }

        .stats-panel {
            width: auto;
            max-height: 45%;
            border-right: 0;
            border-top: 1px solid var(--vis-rule);
        }

        .map-preview {
            flex: none;
            max-height: 180px;
        }
    }

    .stats-panel > .fcol {
        display: grid;
        grid-template-columns: 72px minmax(0, 1fr);
        align-items: center;
        gap: 6px;
    }
    .stats-panel > .field-row label {
        gap: 3px;
    }
    .hint {
        font-size: 12px;
    }
    @media (pointer: coarse) {
        input,
        select,
        button {
            min-height: 36px;
        }
        .stats-panel {
            gap: 8px;
        }
    }
</style>
