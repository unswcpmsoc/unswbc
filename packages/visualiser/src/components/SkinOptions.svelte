<script lang="ts">
    // The Options page body.
    import { settings, persistSettings } from "../settings.svelte";
    import { teamDragonSkins } from "../skins/index";
    import { replayState } from "../replayState.svelte";

    let { compact = false }: { compact?: boolean } = $props();

    function update<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
        settings[key] = value;
        persistSettings();
    }

    // A battle opened from the site carries the skins its teams played in, and
    // those win — two people looking at one battle should see the same dragons.
    const teams = $derived(replayState.opened?.loaded.teams);
    const pinned = $derived(teams?.A.skin !== undefined || teams?.B.skin !== undefined);

    const rows = $derived([
        { key: "teamASkinName", label: "Team A", value: teams?.A.skin ?? settings.teamASkinName },
        { key: "teamBSkinName", label: "Team B", value: teams?.B.skin ?? settings.teamBSkinName },
    ] as const);
</script>

<div class="options" class:compact>
    <p class="hint">Display preferences are saved for every replay.</p>

    <section>
        <h2>Dragons</h2>
        {#each rows as row (row.key)}
            <label class="pick">
                <span>{row.label}</span>
                <select value={row.value} disabled={pinned} onchange={(e) => update(row.key, e.currentTarget.value)}>
                    {#each teamDragonSkins.names as name (name)}
                        <option value={name}>{name}</option>
                    {/each}
                </select>
            </label>
        {/each}
        {#if pinned}
            <p class="note">This battle is played in the skins each team picked, so they can't be changed here.</p>
        {/if}
    </section>

    <section>
        <h2>Interface</h2>
        <label class="check">
            <input
                type="checkbox"
                checked={settings.showAllIndicators}
                onchange={(e) => update("showAllIndicators", e.currentTarget.checked)}
            />
            <span>
                <strong>Show all indicators</strong>
                <small>Show bot status text for every dragon. Off by default.</small>
            </span>
        </label>
        <label class="check">
            <input
                type="checkbox"
                checked={settings.hideUnselectedLogs}
                onchange={(e) => update("hideUnselectedLogs", e.currentTarget.checked)}
            />
            <span>
                <strong>Hide unrelated game logs</strong>
                <small
                    >When dragons are selected, hide events belonging to every other dragon instead of fading them.</small
                >
            </span>
        </label>
    </section>
</div>

<style>
    .options {
        flex: 1;
        overflow: auto;
        padding: 2rem 2.5rem;
        max-width: 480px;
    }

    .options.compact {
        padding: 0.25rem 0;
        max-width: none;
        overflow: visible;
    }

    .hint {
        margin: 0.5rem 0 1.25rem;
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        line-height: 1.6;
        color: var(--vis-ink-3);
    }

    section {
        margin-bottom: 24px;
    }

    h2 {
        margin: 0 0 10px;
        font-size: calc(var(--vis-text-label) * var(--font-scale, 1));
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--vis-ink-3);
    }

    .pick {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.65rem;
        margin-bottom: 0.6rem;
    }

    .pick span {
        color: var(--vis-ink-2);
        font-size: calc(0.76rem * var(--font-scale, 1));
    }

    .pick select {
        flex: 0 1 11rem;
        padding: 0.2rem 0.35rem;
        border: 1px solid var(--vis-rule);
        border-radius: var(--vis-radius-field);
        background: var(--vis-field);
        color: var(--vis-ink-2);
        font: inherit;
        font-size: calc(0.72rem * var(--font-scale, 1));
    }

    .pick select:disabled {
        color: var(--vis-ink-3);
        cursor: not-allowed;
    }

    .note {
        margin: 0.2rem 0 0;
        color: color-mix(in srgb, var(--vis-ink-3) 75%, var(--vis-base-200));
        font-size: calc(0.66rem * var(--font-scale, 1));
        line-height: 1.4;
    }

    .check {
        display: flex;
        align-items: flex-start;
        gap: 0.65rem;
        margin-bottom: 1rem;
        width: auto;
    }

    .check input {
        flex-shrink: 0;
        width: 1rem;
        height: 1rem;
        margin: 0.15rem 0 0;
        accent-color: var(--vis-ink-2);
    }

    .check span {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }

    .check strong {
        color: var(--vis-ink-2);
        font-size: calc(0.76rem * var(--font-scale, 1));
        font-weight: 400;
    }

    .check small {
        color: color-mix(in srgb, var(--vis-ink-3) 75%, var(--vis-base-200));
        font-size: calc(0.66rem * var(--font-scale, 1));
        line-height: 1.4;
    }
</style>
