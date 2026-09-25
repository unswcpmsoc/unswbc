<!-- The rows an entity reports. Shared by the hover tooltip and the pinned window. -->
<script lang="ts">
    import type { EntityDescription } from "./describeEntity";

    let { description, title = true }: { description: EntityDescription; title?: boolean } = $props();
</script>

{#if title}
    <div class="title">{description.title}</div>
{/if}
<dl>
    {#each description.rows as row (row.label)}
        <dt>{row.label}</dt>
        <dd class:danger={row.danger}>{row.value}</dd>
    {/each}
</dl>

<style>
    .title {
        font-size: calc(var(--vis-text-meta) * var(--font-scale, 1));
        font-weight: 600;
        color: var(--vis-ink);
        margin-bottom: 3px;
    }

    dl {
        display: grid;
        grid-template-columns: max-content max-content;
        justify-content: space-between;
        gap: 0 10px;
        margin: 0;
    }

    dt,
    dd {
        font-size: calc(0.75rem * var(--font-scale, 1));
        line-height: 1.45;
    }

    dt {
        color: var(--vis-ink-3);
        white-space: nowrap;
    }

    dd.danger {
        color: #ef4444;
        font-weight: 700;
    }

    dd {
        margin: 0;
        color: var(--vis-ink);
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }
</style>
