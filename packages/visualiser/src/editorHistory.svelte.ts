// History records map contents, not tool settings, clipboard or unfinished drafts.
import { editor, editorUi } from "./mapEditor.svelte";

export const editorHistory = $state({ undo: [] as string[], redo: [] as string[], revision: 0 });
let before: string | undefined;
let depth = 0;

function snapshot(): string {
    const { name, w, h, symm, unitLimit, edgemap, pearls, portals, dragons } = editor;
    return JSON.stringify({ name, w, h, symm, unitLimit: unitLimit ?? null, edgemap, pearls, portals, dragons });
}

function restore(text: string): void {
    const state = JSON.parse(text);
    Object.assign(editor, state, {
        unitLimit: state.unitLimit ?? undefined,
        pendingPortal: undefined,
        dragonDraft: [],
    });
    editorUi.hoveredDragons = [];
    editorHistory.revision++;
}

export function beginEdit(): void {
    if (depth++ === 0) before = snapshot();
}

export function endEdit(): void {
    if (depth === 0 || --depth !== 0) return;
    if (before !== undefined && before !== snapshot()) {
        editorHistory.undo.push(before);
        if (editorHistory.undo.length > 100) editorHistory.undo.shift();
        editorHistory.redo = [];
    }
    before = undefined;
}

export function edit<T>(operation: () => T): T {
    beginEdit();
    try {
        return operation();
    } finally {
        endEdit();
    }
}

export function cancelEdit(): void {
    if (before !== undefined) restore(before);
    before = undefined;
    depth = 0;
}

function travel(backward: boolean): void {
    while (depth) endEdit();
    const from = backward ? editorHistory.undo : editorHistory.redo;
    const to = backward ? editorHistory.redo : editorHistory.undo;
    const previous = from.pop();
    if (previous === undefined) return;
    to.push(snapshot());
    restore(previous);
}

export const undo = () => travel(true);
export const redo = () => travel(false);
