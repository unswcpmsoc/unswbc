import {
    Bodies,
    Dragon,
    classifyBody,
    layoutDragon,
    settledDragonViews,
    stepBetween,
    type DragonMotion,
} from "./Bodies.ts";
import { CurrentMap, StaticMap, type Edge } from "./Map.ts";
import { EdgeTile } from "./Schema.ts";
import type { Vector } from "./Vector.ts";

const CELL = 10;
const BOARD = { width: 8, height: 8 };

const cellOf = (p: Vector) => ({ x: Math.floor(p.x / CELL), y: Math.floor(p.y / CELL) });

/** A dragon one step into a move: `cells` is where it settles, `leave` what its tail is leaving. */
function moving(cells: Vector[], leave: Vector[], progress: number, portals: [Edge, Edge][] = []) {
    const motion: DragonMotion = {
        id: 0,
        team: "A",
        facing: "E",
        cells,
        headSteps: 1,
        headProgress: progress,
        leave,
        tailToGo: (1 - progress) * leave.length,
        alpha: 1,
        moveT: progress,
    };
    return layoutDragon(motion, CELL, portals, BOARD);
}

Deno.test("a plain step glides the head between cells", () => {
    const view = moving(
        [
            { x: 4, y: 3 },
            { x: 3, y: 3 },
        ],
        [{ x: 2, y: 3 }],
        0.5,
    );
    // Halfway through, the head sits on the boundary between the two cells.
    if (Math.abs(view.head.x - 4 * CELL) > 0.01) {
        throw new Error(`head at x=${view.head.x}, expected the 3|4 boundary at ${4 * CELL}`);
    }
    if (Math.abs(view.tail.x - 3 * CELL) > 0.01) {
        throw new Error(`tail at x=${view.tail.x}, expected the 2|3 boundary at ${3 * CELL}`);
    }
});

Deno.test("body art ends half a cell behind each tip", () => {
    const view = moving(
        [
            { x: 4, y: 3 },
            { x: 3, y: 3 },
            { x: 2, y: 3 },
        ],
        [{ x: 1, y: 3 }],
        0.25,
    );
    const [entering, neck, settledTail, leaving] = view.occupancy;
    if (entering.to !== 0) throw new Error("the cell being entered belongs to the head sprite alone");
    if (Math.abs(neck.to - 0.25) > 1e-9) throw new Error(`neck covered to ${neck.to}, expected 0.25`);
    if (Math.abs(settledTail.from - 0.25) > 1e-9)
        throw new Error(`settled tail covered from ${settledTail.from}, expected 0.25`);
    if (leaving.from !== 1) throw new Error("the cell being left belongs to the tail sprite alone");
});

Deno.test("a step across the board seam glides instead of snapping", () => {
    // x = 7 is the right column; stepping east wraps to x = 0.
    for (const t of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const view = moving(
            [
                { x: 0, y: 3 },
                { x: 7, y: 3 },
            ],
            [{ x: 6, y: 3 }],
            t,
        );
        const { x, y } = view.head;
        if (x < 0 || y < 0 || x > BOARD.width * CELL || y > BOARD.height * CELL) {
            throw new Error(`at t=${t} the head left the board at (${x}, ${y})`);
        }
        // It should be leaving the right column or arriving in the left one,
        // never gliding through the middle of the board.
        const column = cellOf(view.head).x;
        if (column !== 0 && column !== 7 && column !== 8) {
            throw new Error(`at t=${t} the head crossed column ${column}; it should hug the seam`);
        }
    }
});

Deno.test("a step through a portal keeps the head at one of its mouths", () => {
    // East side of (3,3) is glued to the west side of (6,6).
    const portals: [Edge, Edge][] = [
        [
            { x: 3, y: 3, side: "E" },
            { x: 6, y: 6, side: "W" },
        ],
    ];
    for (const t of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const view = moving(
            [
                { x: 6, y: 6 },
                { x: 3, y: 3 },
            ],
            [{ x: 2, y: 3 }],
            t,
            portals,
        );
        const at = cellOf(view.head);
        const nearEntry = at.x === 3 || at.x === 4;
        const nearExit = at.x === 6 || at.x === 5;
        if (!(nearEntry || nearExit)) {
            throw new Error(`at t=${t} the head is at cell (${at.x}, ${at.y}); expected a portal mouth`);
        }
    }
});

Deno.test("the tail retracts across the board seam", () => {
    // The whole dragon shifts one east; the tail leaves x = 7 for x = 0.
    const view = moving(
        [
            { x: 2, y: 3 },
            { x: 1, y: 3 },
            { x: 0, y: 3 },
        ],
        [{ x: 7, y: 3 }],
        0.5,
    );
    const tailCell = cellOf(view.tail);
    if (tailCell.x !== 0 && tailCell.x !== 7 && tailCell.x !== 8) {
        throw new Error(`tail at column ${tailCell.x}; it should be crossing the seam`);
    }
    if (view.segments.length !== 2) {
        throw new Error(`expected the body drawn either side of the seam, got ${view.segments.length} piece(s)`);
    }
});

Deno.test("a growing dragon keeps its tail still", () => {
    const view = moving(
        [
            { x: 4, y: 3 },
            { x: 3, y: 3 },
            { x: 2, y: 3 },
        ],
        [],
        0.5,
    );
    if (Math.abs(view.tail.x - 2.5 * CELL) > 0.01)
        throw new Error(`tail at x=${view.tail.x}, expected the centre of cell 2`);
    const tail = view.occupancy[view.occupancy.length - 1];
    if (tail.from !== 1) throw new Error("a still tail cell belongs to the tail sprite alone");
});

Deno.test("a body split across the seam draws as two pieces", () => {
    const bodies = new Bodies();
    bodies.dragons.set(
        0,
        new Dragon(0, "A", "E", [
            { x: 0, y: 3 },
            { x: 7, y: 3 },
            { x: 6, y: 3 },
        ]),
    );
    const [view] = settledDragonViews(bodies, CELL, [], BOARD);
    if (view.segments.length !== 2) {
        throw new Error(`expected 2 drawn pieces across the seam, got ${view.segments.length}`);
    }
});

Deno.test("the pieces either side of a seam meet at the board edge", () => {
    const view = moving(
        [
            { x: 0, y: 3 },
            { x: 7, y: 3 },
            { x: 6, y: 3 },
        ],
        [{ x: 5, y: 3 }],
        0.75,
    );
    if (view.segments.length !== 2) {
        throw new Error(`expected the body drawn either side of the seam, got ${view.segments.length} piece(s)`);
    }
    const [arriving, leaving] = view.segments;
    // The arriving piece must run all the way back to the left edge and the
    // leaving piece start at the right edge, or the dragon looks severed.
    const arrivingEnd = arriving[arriving.length - 1];
    if (Math.abs(arrivingEnd.x) > 0.01) {
        throw new Error(`arriving piece stops at x=${arrivingEnd.x}, expected the left edge at 0`);
    }
    if (Math.abs(leaving[0].x - BOARD.width * CELL) > 0.01) {
        throw new Error(`leaving piece starts at x=${leaving[0].x}, expected the right edge at ${BOARD.width * CELL}`);
    }
    for (const piece of view.segments) {
        if (piece.length < 2) throw new Error("a drawn piece collapsed to a single point");
    }
});

Deno.test("a portal crossing draws at both mouths", () => {
    const portals: [Edge, Edge][] = [
        [
            { x: 3, y: 3, side: "E" },
            { x: 6, y: 6, side: "W" },
        ],
    ];
    const view = moving(
        [
            { x: 6, y: 6 },
            { x: 3, y: 3 },
        ],
        [{ x: 2, y: 3 }],
        0.75,
        portals,
    );
    if (view.segments.length !== 2) {
        throw new Error(`expected both mouths drawn, got ${view.segments.length} piece(s)`);
    }
    const arriving = view.segments[0];
    // The head is inside (6,6) and its piece reaches back to that cell's west side.
    const backEdge = arriving[arriving.length - 1];
    if (Math.abs(backEdge.x - 6 * CELL) > 0.01) {
        throw new Error(`arriving piece stops at x=${backEdge.x}, expected the portal mouth at ${6 * CELL}`);
    }
});

Deno.test("a step that spends a segment retracts the tail over both cells it left", () => {
    // Settles on 6,5,4 having left 3 then 2 (furthest first in `leave`).
    const cells = [
        { x: 6, y: 3 },
        { x: 5, y: 3 },
        { x: 4, y: 3 },
    ];
    const leave = [
        { x: 2, y: 3 },
        { x: 3, y: 3 },
    ];
    for (const [t, expected] of [
        [0, 2.5],
        [0.25, 3.0],
        [0.5, 3.5],
        [1, 4.5],
    ] as const) {
        const view = moving(cells, leave, t);
        if (Math.abs(view.tail.x - expected * CELL) > 0.01) {
            throw new Error(`at t=${t} the tail is at x=${view.tail.x}, expected ${expected * CELL}`);
        }
        // Every cell between the tip and the body is accounted for: no gap.
        for (let i = 1; i < view.occupancy.length; i++) {
            const a = view.occupancy[i - 1].cell;
            const b = view.occupancy[i].cell;
            if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) {
                throw new Error(`at t=${t} occupancy jumps from (${a.x},${a.y}) to (${b.x},${b.y})`);
            }
        }
    }
    const half = moving(cells, leave, 0.5);
    const covers = half.occupancy.map((o) => `${o.cell.x}:${o.from.toFixed(2)}-${o.to.toFixed(2)}`).join(" ");
    if (covers !== "6:0.00-0.00 5:0.00-0.50 4:0.00-1.00 3:1.00-1.00 2:1.00-1.00") {
        throw new Error(`coverage at t=0.5 is "${covers}"`);
    }
});

Deno.test("a dying head bumps into the cell it hit", () => {
    const view = layoutDragon(
        {
            id: 0,
            team: "A",
            facing: "E",
            cells: [
                { x: 3, y: 3 },
                { x: 2, y: 3 },
            ],
            contact: { x: 4, y: 3 },
            contactAdvance: 0.5,
            alpha: 1,
            moveT: 1,
        },
        CELL,
        [],
        BOARD,
    );
    if (Math.abs(view.head.x - 4 * CELL) > 0.01) {
        throw new Error(`head at x=${view.head.x}, expected the shared boundary at ${4 * CELL}`);
    }
    if (view.occupancy[0].cell.x !== 4 || view.occupancy[0].to !== 0) {
        throw new Error("the contact cell holds only the head sprite");
    }
});

Deno.test("a body that bends across the seam is classified as a turn", () => {
    // Head at (0,3) having come from (7,3) by wrapping east, with the body
    // then running north. The middle cell is a corner, not a straight run.
    const cells = [
        { x: 0, y: 3 },
        { x: 7, y: 3 },
        { x: 7, y: 2 },
    ];

    const withBoard = classifyBody(cells, "E", [], BOARD);
    if (withBoard[1].kind !== "turn") {
        throw new Error(`the seam cell is "${withBoard[1].kind}", expected "turn"`);
    }

    // The same bend one cell in from the border, as the reference shape.
    const inland = classifyBody(
        [
            { x: 3, y: 3 },
            { x: 2, y: 3 },
            { x: 2, y: 2 },
        ],
        "E",
        [],
        BOARD,
    );
    if (withBoard[1].rot !== inland[1].rot || withBoard[1].turnDir !== inland[1].turnDir) {
        throw new Error(
            `seam bend is rot ${withBoard[1].rot}/${withBoard[1].turnDir}, ` +
                `inland bend is rot ${inland[1].rot}/${inland[1].turnDir}`,
        );
    }
});

Deno.test("a body bending through a portal is classified as a turn", () => {
    const portals: [Edge, Edge][] = [
        [
            { x: 3, y: 3, side: "E" },
            { x: 6, y: 6, side: "W" },
        ],
    ];
    // Head emerged at (6,6); the neck is back at (3,3) and the body runs north
    // from there, so the neck is a corner.
    const cells = [
        { x: 6, y: 6 },
        { x: 3, y: 3 },
        { x: 3, y: 2 },
    ];

    const parts = classifyBody(cells, "E", portals, BOARD);
    if (parts[1].kind !== "turn") {
        throw new Error(`the portal cell is "${parts[1].kind}", expected "turn"`);
    }
});

Deno.test("a body bending through a left-edge portal from the right resolves its rotation", () => {
    // The west edge of (0,3) is also the east edge of (7,3) on the torus.
    const portals: [Edge, Edge][] = [
        [
            { x: 0, y: 3, side: "W" },
            { x: 5, y: 6, side: "W" },
        ],
    ];
    const cells = [
        { x: 5, y: 7 },
        { x: 5, y: 6 },
        { x: 7, y: 3 },
        { x: 7, y: 2 },
    ];

    if (stepBetween(cells[2], cells[1], BOARD, portals) !== "E") {
        throw new Error("the right-edge approach did not resolve as an eastward portal step");
    }
    const parts = classifyBody(cells, "S", portals, BOARD);
    if (parts[1].kind !== "turn" || parts[2].kind !== "turn") {
        throw new Error(`portal mouths classified as ${parts[1].kind}/${parts[2].kind}, expected two turns`);
    }
});

Deno.test("a portal to the far side beats the wrap it looks like", () => {
    // Two pairs, each joining the inside of one side to the inside of the
    // other. The dragon lands on the opposite edge either way, and on a bordered
    // map only the portal could have taken it there.
    const portals: [Edge, Edge][] = [
        [
            { x: 0, y: 3, side: "E" },
            { x: 7, y: 3, side: "W" },
        ],
        [
            { x: 0, y: 6, side: "E" },
            { x: 7, y: 6, side: "W" },
        ],
    ];

    const cases: [Vector, Vector, string][] = [
        [{ x: 0, y: 3 }, { x: 7, y: 3 }, "E"],
        [{ x: 7, y: 3 }, { x: 0, y: 3 }, "W"],
        [{ x: 0, y: 6 }, { x: 7, y: 6 }, "E"],
        [{ x: 7, y: 6 }, { x: 0, y: 6 }, "W"],
        // A row no portal touches still wraps.
        [{ x: 0, y: 5 }, { x: 7, y: 5 }, "W"],
    ];
    for (const [from, to, want] of cases) {
        const got = stepBetween(from, to, BOARD, portals);
        if (got !== want) {
            throw new Error(`(${from.x},${from.y}) to (${to.x},${to.y}) stepped ${got}, expected ${want}`);
        }
    }
});

Deno.test("a portal step past a kelp wall is not drawn through the kelp", () => {
    // (3,3) and (4,3) share a kelp wall; the portal on the west side of (3,3)
    // comes out of the east side of (4,3), so going west from (3,3) lands in
    // (4,3) without crossing the wall.
    const portals: [Edge, Edge][] = [
        [
            { x: 3, y: 3, side: "W" },
            { x: 4, y: 3, side: "E" },
        ],
    ];
    const vEdges = new Uint8Array(8 * 9);
    vEdges[3 * 9 + 3] = EdgeTile.Portal;
    vEdges[3 * 9 + 4] = EdgeTile.Kelp;
    vEdges[3 * 9 + 5] = EdgeTile.Portal;
    const map = new CurrentMap(
        new StaticMap(8, 8, new Uint8Array(64), new Uint8Array(72), vEdges, portals, [], []),
    );

    const got = stepBetween({ x: 3, y: 3 }, { x: 4, y: 3 }, map, portals);
    if (got !== "W") throw new Error(`(3,3) to (4,3) stepped ${got}, expected W through the portal`);
});

Deno.test("a body bending through a top-edge portal from the bottom resolves its rotation", () => {
    // The north edge of (3,0) is also the south edge of (3,7) on the torus.
    const portals: [Edge, Edge][] = [
        [
            { x: 3, y: 0, side: "N" },
            { x: 6, y: 5, side: "N" },
        ],
    ];
    const cells = [
        { x: 7, y: 4 },
        { x: 6, y: 4 },
        { x: 3, y: 7 },
        { x: 2, y: 7 },
    ];

    if (stepBetween(cells[2], cells[1], BOARD, portals) !== "S") {
        throw new Error("the bottom-edge approach did not resolve as a southward portal step");
    }
    const parts = classifyBody(cells, "E", portals, BOARD);
    if (parts[1].kind !== "turn" || parts[2].kind !== "turn") {
        throw new Error(`portal mouths classified as ${parts[1].kind}/${parts[2].kind}, expected two turns`);
    }
});

Deno.test("a straight run across the seam stays straight", () => {
    const cells = [
        { x: 0, y: 3 },
        { x: 7, y: 3 },
        { x: 6, y: 3 },
    ];
    const parts = classifyBody(cells, "E", [], BOARD);
    if (parts[1].kind !== "body") {
        throw new Error(`the seam cell is "${parts[1].kind}", expected "body"`);
    }
});

Deno.test("a two-step move runs the head through the shared cell without a break", () => {
    // Two steps north then east: 3,5 -> 3,4 -> 4,4. The head must pass through
    // (3,4) continuously, turning as it goes, and never leave the body's cut
    // uncovered.
    const cells = [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
        { x: 3, y: 5 },
        { x: 3, y: 6 },
    ];
    let previous: Vector | undefined;
    for (let progress = 0; progress <= 2; progress += 0.05) {
        const view = layoutDragon(
            { id: 0, team: "A", facing: "E", cells, headSteps: 2, headProgress: progress, alpha: 1, moveT: 1 },
            CELL,
            [],
            BOARD,
        );
        if (previous) {
            const moved = Math.hypot(view.head.x - previous.x, view.head.y - previous.y);
            if (moved > CELL * 0.12)
                throw new Error(`head jumped ${moved.toFixed(2)}px at progress ${progress.toFixed(2)}`);
        }
        previous = view.head;
        if (
            progress === 0 &&
            (Math.abs(view.head.x - 3.5 * CELL) > 0.01 || Math.abs(view.head.y - 5.5 * CELL) > 0.01)
        ) {
            throw new Error(`head starts at (${view.head.x}, ${view.head.y}), expected the centre of (3,5)`);
        }
        if (
            Math.abs(progress - 1) < 1e-9 &&
            (Math.abs(view.head.x - 3.5 * CELL) > 0.01 || Math.abs(view.head.y - 4.5 * CELL) > 0.01)
        ) {
            throw new Error(`head is at (${view.head.x}, ${view.head.y}) after one step, expected the centre of (3,4)`);
        }
    }
    const end = layoutDragon(
        { id: 0, team: "A", facing: "E", cells, headSteps: 2, headProgress: 2, alpha: 1, moveT: 1 },
        CELL,
        [],
        BOARD,
    );
    if (Math.abs(end.head.x - 4.5 * CELL) > 0.01 || Math.abs(end.headDir.x - 1) > 1e-9) {
        throw new Error(
            `head ends at (${end.head.x}, ${end.head.y}) facing (${end.headDir.x}, ${end.headDir.y}), expected the centre of (4,4) facing east`,
        );
    }
});

Deno.test("the head cap stays half a cell ahead of the body cut through a corner", () => {
    const cells = [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
        { x: 3, y: 5 },
    ];
    for (const progress of [0.2, 0.5, 0.8]) {
        const view = layoutDragon(
            { id: 0, team: "A", facing: "E", cells, headSteps: 1, headProgress: progress, alpha: 1, moveT: 1 },
            CELL,
            [],
            BOARD,
        );
        // The neck (3,4) bends from north-going to east-going; its wipe reaches
        // `progress` of the way round, so the cap's rear edge must not be short of it.
        const neck = view.occupancy[1];
        if (Math.abs(neck.to - progress) > 1e-9) throw new Error(`neck covered to ${neck.to}, expected ${progress}`);
        // The body enters (3,4) from the south and leaves east, so it bends round
        // the cell's south-east corner. The cut sits on the arc of radius half a
        // cell about that corner and the cap half a cell along the tangent, so
        // the cap centre is always sqrt(2)/2 cells from the corner.
        const pivot = { x: 4 * CELL, y: 5 * CELL };
        const capToPivot = Math.hypot(view.head.x - pivot.x, view.head.y - pivot.y);
        if (Math.abs(capToPivot - Math.SQRT1_2 * CELL) > 0.01) {
            throw new Error(
                `at progress ${progress} the cap is ${(capToPivot / CELL).toFixed(3)} cells from the corner pivot`,
            );
        }
    }
});
