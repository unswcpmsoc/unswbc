import {
    StaticMap,
    CurrentMap,
    serializeMapText,
    edgeIdToSlot,
    edgeToId,
    wrappedEdgeKey,
    type Edge,
    type MapSymmetry,
} from "./Map.ts";
import type { Direction } from "./Vector.ts";

Deno.test("editor export omits bottom/right edge records and preserves portal pairs", () => {
    const map = new StaticMap(
        5,
        4,
        new Uint8Array(20),
        new Uint8Array(25),
        new Uint8Array(24),
        [
            [
                { x: 2, y: 0, side: "N" },
                { x: 3, y: 2, side: "N" },
            ],
        ],
        [],
        Array.from({ length: 20 }, () => ({ minRounds: 0, maxRounds: 0 })),
    );
    const text = serializeMapText(map, { canonicalEdgesOnly: true });
    const edges = text.split("\n").filter((line) => line.startsWith("EDGE "));
    if (edges.length !== 2 * map.width * map.height) throw new Error("expected one record per wrapped boundary");
    for (const line of edges) {
        const id = Number(line.split(" ")[1]);
        if (id % (map.width + 1) >= map.width || Math.floor(id / (map.width + 1)) >= 2 * map.height) {
            throw new Error(`export included a bottom/right edge: ${line}`);
        }
    }
    const parsed = StaticMap.fromMapText(text);
    if (JSON.stringify(parsed.portals) !== JSON.stringify(map.portals)) throw new Error("portal pairing changed");
    if (serializeMapText(parsed, { canonicalEdgesOnly: true }) !== text) throw new Error("export did not round-trip");
});

const REAL_MAPS = ["../../../../maps/small.map", "../../../../maps/default.map"];

function readFixture(path: string): string {
    return Deno.readTextFileSync(new URL(path, import.meta.url)).replace(/^SYMMETRY .*\n/m, "");
}

Deno.test("round limits are absent from maps, including imported legacy headers", () => {
    const text = readFixture(REAL_MAPS[0]);
    for (const header of ["", "ROUNDS 12\n", "ROUNDS 900\n"]) {
        const legacy = text.replace(/^(MAP .*)$/m, `$1\n${header}`);
        const map = StaticMap.fromMapText(legacy);
        if ("roundLimit" in map) throw new Error("map still stores a round limit");
        if (/^ROUNDS\b/m.test(serializeMapText(map))) throw new Error("map writes a round limit");
    }
});

Deno.test("replays from before the dragon rename still parse, and write back as DRAGON", () => {
    const text = readFixture(REAL_MAPS[1]);
    const legacy = text.replaceAll("DRAGON_COUNT", "SNAKE_COUNT").replaceAll(/^DRAGON /gm, "SNAKE ");
    if (!/^SNAKE_COUNT /m.test(legacy) || !/^SNAKE /m.test(legacy)) throw new Error("fixture has no body keywords");
    const map = StaticMap.fromMapText(legacy);
    if (map.initialDragons.length !== StaticMap.fromMapText(text).initialDragons.length)
        throw new Error("dragons went missing");
    if (/\bSNAKE/.test(serializeMapText(map))) throw new Error("map wrote the old spelling back out");
});

Deno.test("the repo maps parse and re-serialize byte-identically", () => {
    for (const path of REAL_MAPS) {
        const text = Deno.readTextFileSync(new URL(path, import.meta.url));
        const map = StaticMap.fromMapText(text);
        const again = serializeMapText(map, { canonicalEdgesOnly: true });
        if (again !== text) {
            const wrote = again.split("\n");
            const read = text.split("\n");
            const at = wrote.findIndex((line, i) => line !== read[i]);
            throw new Error(`${path} differs at line ${at + 1}:\n  file  ${read[at]}\n  ours  ${wrote[at]}`);
        }
    }
});

Deno.test("parsing a re-serialized map yields the same board", () => {
    const directory = new URL("../../../../maps/", import.meta.url);
    for (const file of Deno.readDirSync(directory)) {
        if (!file.name.endsWith(".map")) continue;
        const path = new URL(file.name, directory).href;
        const first = StaticMap.fromMapText(Deno.readTextFileSync(new URL(path, import.meta.url)));
        const second = StaticMap.fromMapText(serializeMapText(first));
        const shape = (map: StaticMap) => ({
            width: map.width,
            height: map.height,
            tiles: [...map.initialTiles],
            hEdges: [...map.initialHEdges],
            vEdges: [...map.initialVEdges],
            portals: map.portals,
            dragons: map.initialDragons,
            pearls: map.pearlRespawn,
        });
        const a = JSON.stringify(shape(first));
        const b = JSON.stringify(shape(second));
        if (a !== b) throw new Error(`${path} changed across a serialize/parse cycle`);
    }
});

Deno.test("edge ids round-trip through their grid slots", () => {
    const width = 5;
    const height = 4;
    for (let row = 0; row <= 2 * height; row++) {
        const columns = row % 2 === 0 ? width : width + 1;
        for (let column = 0; column < columns; column++) {
            const id = row * (width + 1) + column;
            const slot = edgeIdToSlot(id, width, height);
            const back = edgeToId(slot.edge, width);
            if (back !== id) throw new Error(`edge id ${id} came back as ${back}`);
        }
    }
});

Deno.test("a horizontal padding slot is rejected", () => {
    let threw = false;
    try {
        edgeIdToSlot(5, 5, 4); // row 0, column 5: no boundary above tile 5 of 5
    } catch {
        threw = true;
    }
    if (!threw) throw new Error("padding slot was accepted");
});

function withHeader(lines: string): string {
    return readFixture(REAL_MAPS[0])
        .replace(/^(UNIT_LIMIT|SYMMETRY) .*\n/gm, "")
        .replace(/^(MAP .*)$/m, `$1\n${lines}`);
}

Deno.test("UNIT_LIMIT and SYMMETRY are read and written back where they were", () => {
    for (const symmetry of ["x", "y", "xy"]) {
        const text = withHeader(`UNIT_LIMIT 12\nSYMMETRY ${symmetry}`);
        const map = StaticMap.fromMapText(text);
        if (map.symmetry !== symmetry) throw new Error(`SYMMETRY ${symmetry} parsed as ${map.symmetry}`);
        if (map.unitLimit !== 12) throw new Error(`UNIT_LIMIT 12 parsed as ${map.unitLimit}`);
        if (serializeMapText(map, { canonicalEdgesOnly: true }) !== text)
            throw new Error(`SYMMETRY ${symmetry} did not round-trip byte-identically`);
    }
});

Deno.test("a map without UNIT_LIMIT or SYMMETRY has neither, and does not gain them", () => {
    const map = StaticMap.fromMapText(withHeader(""));
    if (map.unitLimit !== undefined || map.symmetry !== undefined) {
        throw new Error(`expected neither, got ${map.unitLimit} / ${map.symmetry}`);
    }
    const again = serializeMapText(map);
    if (/^(UNIT_LIMIT|SYMMETRY)/m.test(again)) throw new Error("serializing added a header line");
});

Deno.test("MAP_NAME keeps the whole line, spaces and all, and is written back where it was", () => {
    for (const name of ["Small", "Queen Of Spades But She Ages", "map-1.0 (rev b)"]) {
        const text = readFixture(REAL_MAPS[0]).replace(/^MAP_NAME .*$/m, `MAP_NAME ${name}`);
        const map = StaticMap.fromMapText(text);
        if (map.mapName !== name) throw new Error(`MAP_NAME "${name}" parsed as "${map.mapName}"`);
        if (serializeMapText(map, { canonicalEdgesOnly: true }) !== text)
            throw new Error(`MAP_NAME "${name}" did not round-trip byte-identically`);
    }
});

Deno.test("a map without MAP_NAME has none, and does not gain one", () => {
    const text = readFixture(REAL_MAPS[0]).replace(/^MAP_NAME .*\n/m, "");
    const map = StaticMap.fromMapText(text);
    if (map.mapName !== undefined) throw new Error(`expected none, got ${map.mapName}`);
    if (/^MAP_NAME/m.test(serializeMapText(map))) throw new Error("serializing added a MAP_NAME line");
});

Deno.test("every repo map carries a MAP_NAME", () => {
    const dir = new URL("../../../../maps/", import.meta.url);
    for (const file of Deno.readDirSync(dir)) {
        if (!file.name.endsWith(".map")) continue;
        const map = StaticMap.fromMapText(Deno.readTextFileSync(new URL(file.name, dir)));
        if (!map.mapName) throw new Error(`${file.name} has no MAP_NAME`);
    }
});

const MIRRORED_SIDE: Record<MapSymmetry, Record<Direction, Direction>> = {
    x: { N: "S", E: "E", S: "N", W: "W" },
    y: { N: "N", E: "W", S: "S", W: "E" },
    xy: { N: "S", E: "W", S: "N", W: "E" },
};

function mirrorEdgeKey(map: StaticMap, edge: Edge): string {
    const [kind, coordinates] = wrappedEdgeKey(edge, map.width, map.height).split(":");
    let [column, row] = coordinates.split(",").map(Number);
    if (map.symmetry !== "x") column = kind === "H" ? map.width - 1 - column : (map.width - column) % map.width;
    if (map.symmetry !== "y") row = kind === "V" ? map.height - 1 - row : (map.height - row) % map.height;
    return `${kind}:${column},${row}`;
}

Deno.test("every repo map declares the symmetry it has, in beds, boundaries and spawns", () => {
    const dir = new URL("../../../../maps/", import.meta.url);
    for (const file of Deno.readDirSync(dir)) {
        if (!file.name.endsWith(".map")) continue;
        const map = StaticMap.fromMapText(Deno.readTextFileSync(new URL(file.name, dir)));
        if (!map.symmetry) throw new Error(`${file.name} declares no SYMMETRY`);
        const board = new CurrentMap(map);
        const flip = MIRRORED_SIDE[map.symmetry];
        const keyOf = (edge: Edge) => wrappedEdgeKey(edge, map.width, map.height);
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                const mirror = map.mirrorTile(x, y);
                const here = map.pearlRespawn[map.locationToIndex(x, y)];
                const there = map.pearlRespawn[map.locationToIndex(mirror.x, mirror.y)];
                if (here.minRounds !== there.minRounds || here.maxRounds !== there.maxRounds) {
                    throw new Error(
                        `${file.name}: the pearl bed at (${x}, ${y}) differs from its mirror at (${mirror.x}, ${mirror.y})`,
                    );
                }
                for (const side of ["N", "E", "S", "W"] as const) {
                    if (board.edgeAt(x, y, side) !== board.edgeAt(mirror.x, mirror.y, flip[side])) {
                        throw new Error(`${file.name}: the ${side} boundary of (${x}, ${y}) differs from its mirror`);
                    }
                    const partner = map.portalMap.get(keyOf({ x, y, side }));
                    const other = map.portalMap.get(keyOf({ x: mirror.x, y: mirror.y, side: flip[side] }));
                    if (!partner !== !other || (partner && other && mirrorEdgeKey(map, partner) !== keyOf(other))) {
                        throw new Error(
                            `${file.name}: the portal on the ${side} of (${x}, ${y}) does not lead to the mirror of its partner`,
                        );
                    }
                }
            }
        }
        const spell = (body: readonly { x: number; y: number }[]) => body.map((c) => `${c.x},${c.y}`).join(" ");
        const mirroredA = map.initialDragons
            .filter((dragon) => dragon.team === "A")
            .map((dragon) => spell(dragon.body.map((c) => map.mirrorTile(c.x, c.y))))
            .sort();
        const spawnsB = map.initialDragons
            .filter((dragon) => dragon.team === "B")
            .map((dragon) => spell(dragon.body))
            .sort();
        if (mirroredA.join(" | ") !== spawnsB.join(" | ")) {
            throw new Error(`${file.name}: team A's spawns are not team B's, mirrored`);
        }
    }
});

Deno.test("bad UNIT_LIMIT and SYMMETRY lines are rejected", () => {
    const bads = [
        "SYMMETRY z",
        "SYMMETRY xy extra",
        "SYMMETRY",
        "UNIT_LIMIT 0",
        "UNIT_LIMIT -3",
        "UNIT_LIMIT 2 3",
        "UNIT_LIMIT x",
    ];
    for (const bad of bads) {
        let threw = false;
        try {
            StaticMap.fromMapText(withHeader(bad));
        } catch {
            threw = true;
        }
        if (!threw) throw new Error(`"${bad}" was accepted`);
    }
});

Deno.test("mirrorTile follows the engine: x flips rows, y flips columns, xy both", () => {
    const plain = StaticMap.fromMapText(withHeader(""));
    const want: Record<string, [number, number]> = {
        x: [2, plain.height - 2],
        y: [plain.width - 3, 1],
        xy: [plain.width - 3, plain.height - 2],
    };
    for (const [symmetry, [wx, wy]] of Object.entries(want)) {
        const map = StaticMap.fromMapText(withHeader(`SYMMETRY ${symmetry}`));
        const got = map.mirrorTile(2, 1);
        if (got.x !== wx || got.y !== wy)
            throw new Error(`${symmetry}: (2,1) mirrored to (${got.x},${got.y}), want (${wx},${wy})`);
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                const m = map.mirrorTile(x, y);
                const back = map.mirrorTile(m.x, m.y);
                if (back.x !== x || back.y !== y) throw new Error(`${symmetry}: (${x},${y}) did not mirror back`);
            }
        }
    }
    const self = plain.mirrorTile(2, 1);
    if (self.x !== 2 || self.y !== 1) throw new Error("a map without symmetry mirrored a tile");
});
