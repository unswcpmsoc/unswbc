import { entityAt } from "./Entities.ts";
import { StaticMap, type Edge } from "./Map.ts";
import Match from "./Match.ts";

function board(portals: [Edge, Edge][]) {
    const map = new StaticMap(
        10,
        10,
        new Uint8Array(100),
        new Uint8Array(110),
        new Uint8Array(110),
        portals,
        [],
        Array.from({ length: 100 }, () => ({ minRounds: 0, maxRounds: 0 })),
    );
    const match = new Match(map);
    return { frame: match.frameAt(0), map: match.roundAt(0).map };
}

Deno.test("hidden bottom/right portal mouths cannot be hovered or picked", () => {
    const { frame, map } = board([
        [
            { x: 2, y: 0, side: "N" },
            { x: 6, y: 4, side: "N" },
        ],
        [
            { x: 2, y: 10, side: "N" },
            { x: 6, y: 4, side: "N" },
        ],
        [
            { x: 0, y: 6, side: "W" },
            { x: 4, y: 2, side: "W" },
        ],
        [
            { x: 10, y: 6, side: "W" },
            { x: 4, y: 2, side: "W" },
        ],
    ]);
    for (const point of [
        { x: 2.5, y: 9.9 },
        { x: 9.9, y: 6.5 },
    ]) {
        if (entityAt(point, frame, map)?.kind !== "cell") throw new Error("hidden portal captured the pointer");
    }
    for (const point of [
        { x: 2.5, y: 0.1 },
        { x: 0.1, y: 6.5 },
        { x: 6.5, y: 4.1 },
    ]) {
        if (entityAt(point, frame, map)?.kind !== "portal") throw new Error("visible portal is no longer selectable");
    }
});

Deno.test("visible interior portal mouths near the bottom/right remain selectable", () => {
    const { frame, map } = board([
        [
            { x: 4, y: 9, side: "W" },
            { x: 6, y: 3, side: "W" },
        ],
        [
            { x: 9, y: 4, side: "N" },
            { x: 3, y: 6, side: "N" },
        ],
    ]);
    for (const point of [
        { x: 4.1, y: 9.8 },
        { x: 9.8, y: 4.1 },
    ]) {
        if (entityAt(point, frame, map)?.kind !== "portal") throw new Error("visible interior portal was hidden");
    }
});
