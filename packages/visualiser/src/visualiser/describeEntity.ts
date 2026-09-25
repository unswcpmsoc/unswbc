// What each entity says about itself. One place, so the hover tooltip and the
// pinned window can never drift apart.

import type { Entity } from "./Entities";
import type { CurrentMap, Edge } from "./Map";
import type { TimelineFrame } from "./Match";
import type { PearlClock } from "./PearlClock";
import type { DragonAges } from "./DragonAges";
import { Tile } from "./Schema";

export interface EntityRow {
    label: string;
    value: string;
    danger?: boolean;
}

export interface EntityDescription {
    title: string;
    rows: EntityRow[];
}

export interface DescribeContext {
    frame: TimelineFrame;
    map: CurrentMap;
    round: number;
    pearlClock: PearlClock;
    dragonAges: DragonAges;
}

function describeCell(x: number, y: number, context: DescribeContext): EntityDescription {
    const { map, pearlClock, round } = context;
    const interval = map.staticMap.pearlRespawn[y * map.width + x];
    const pearlIn = pearlClock.pearlIn(x, y, round, map);

    const range = interval.maxRounds > 0 ? `${interval.minRounds}–${interval.maxRounds} rounds` : "Never";
    const rows: EntityRow[] = [
        { label: "Position", value: `(${x}, ${y})` },
        { label: "Pearl", value: map.tileAt(x, y) === Tile.Pearl ? "Yes" : "No" },
        { label: "Next pearl", value: pearlIn === undefined ? "Unknown" : `in ${pearlIn} rounds` },
        { label: "Respawns after", value: range },
    ];
    if (map.staticMap.symmetry && interval.maxRounds > 0) {
        const mirror = map.staticMap.mirrorTile(x, y);
        const onAxis = mirror.x === x && mirror.y === y;
        rows.push({ label: "Mirror tile", value: onAxis ? "Itself (on the axis)" : `(${mirror.x}, ${mirror.y})` });
    }
    return { title: "Tile", rows };
}

function describeDragon(dragonId: number, context: DescribeContext): EntityDescription {
    const { frame, dragonAges, round } = context;
    const dragon = frame.timeline.end.bodies.getById(dragonId);
    const age = dragonAges.ageAt(dragonId, round);
    const usage = frame.timeline.actions.get(dragonId)?.instructions;
    const exceeded = usage !== undefined && (usage.exceeded || usage.count > 100_000_000);

    return {
        title: "Dragon",
        rows: [
            { label: "ID", value: `${dragonId}` },
            { label: "Length", value: dragon ? `${dragon.body.length}` : "—" },
            { label: "Age", value: `${age} rounds` },
            { label: "Alive", value: dragonAges.alive(dragonId, round) ? "Yes" : "No" },
            ...(usage
                ? [
                      {
                          label: "Instructions",
                          value: exceeded ? "INSTRUCTIONS EXCEEDED" : usage.count.toLocaleString("en-US"),
                          danger: exceeded,
                      },
                  ]
                : []),
        ],
    };
}

function describePortal(pairIndex: number, ends: readonly [Edge, Edge]): EntityDescription {
    const [a, b] = ends;
    return {
        title: "Portal",
        rows: [
            { label: "Pair", value: `${pairIndex}` },
            { label: "Ends", value: `(${a.x}, ${a.y}) ↔ (${b.x}, ${b.y})` },
        ],
    };
}

export function describeEntity(entity: Entity, context: DescribeContext): EntityDescription {
    if (entity.kind === "cell") return describeCell(entity.x, entity.y, context);
    if (entity.kind === "dragon") return describeDragon(entity.dragonId, context);
    return describePortal(entity.pairIndex, entity.ends);
}
