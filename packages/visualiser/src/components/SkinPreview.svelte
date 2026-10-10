<script lang="ts">
    // One skin drawn as a short dragon at rest, so a look can be picked by
    // sight. No animation: skins that flow do it off the clock, and a still
    // frame is what a picker needs.
    import { layoutDragon } from "../visualiser/Bodies";
    import { teamDragonSkins } from "../skins/index";

    let {
        name,
        cell = 34,
        length = 4,
        label,
    }: {
        name: string;
        /** Cell size in CSS pixels; the canvas is `length` of them wide. */
        cell?: number;
        length?: number;
        label?: string;
    } = $props();

    let canvas: HTMLCanvasElement | undefined = $state();

    $effect(() => {
        const el = canvas;
        const ctx = el?.getContext("2d");
        if (!el || !ctx) return;

        const skin = teamDragonSkins.get(name);
        const dpr = window.devicePixelRatio || 1;
        el.width = Math.round(length * cell * dpr);
        el.height = Math.round(cell * dpr);

        let live = true;
        const draw = () => {
            if (!live) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, length * cell, cell);
            const view = layoutDragon(
                {
                    id: 0,
                    team: "A",
                    facing: "E",
                    // Head first, so the dragon runs tail-left to head-right.
                    cells: Array.from({ length }, (_, i) => ({ x: length - 1 - i, y: 0 })),
                    alpha: 1,
                    moveT: 1,
                },
                cell,
            );
            skin.drawDragon(ctx, view, { cell, time: 0 });
        };

        draw();
        // Sprite sheets decode asynchronously; until one does the skin draws
        // its vector stand-in, so draw again when the image lands.
        skin.ready?.then(draw);
        return () => {
            live = false;
        };
    });
</script>

<canvas bind:this={canvas} style:width="{length * cell}px" style:height="{cell}px" aria-label={label ?? name}></canvas>

<style>
    canvas {
        display: block;
    }
</style>
