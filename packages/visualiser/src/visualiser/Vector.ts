// 2D vector math and grid-direction helpers. Coordinates: (0,0) top-left,
// x east, y south, matching .map files and canvas.

export interface Vector {
    x: number;
    y: number;
}

export const vectorEq = (a: Vector, b: Vector): boolean => a.x === b.x && a.y === b.y;
export const vectorAdd = (a: Vector, b: Vector): Vector => ({ x: a.x + b.x, y: a.y + b.y });
export const vectorSub = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y });
export const vectorMultiply = (a: Vector, b: number): Vector => ({ x: a.x * b, y: a.y * b });
export const vectorLength = (a: Vector): number => Math.hypot(a.x, a.y);
export const vectorDist = (a: Vector, b: Vector): number => Math.hypot(b.x - a.x, b.y - a.y);
export const vectorLerp = (a: Vector, b: Vector, t: number): Vector => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
});

/** Compass direction; also the side of a cell an edge sits on. */
export type Direction = "N" | "E" | "S" | "W";

/** Unit step per direction. */
export const DIRECTION_DELTA: Record<Direction, Vector> = {
    N: { x: 0, y: -1 },
    E: { x: 1, y: 0 },
    S: { x: 0, y: 1 },
    W: { x: -1, y: 0 },
};

export const OPPOSITE: Record<Direction, Direction> = { N: "S", S: "N", E: "W", W: "E" };

/** Cell one step from `p` in `dir` (no bounds/wall checks). */
export const movePoint = (p: Vector, dir: Direction): Vector => vectorAdd(p, DIRECTION_DELTA[dir]);

/** Direction from `from` to an orthogonally adjacent `to`, or undefined. */
export function directionBetween(from: Vector, to: Vector): Direction | undefined {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 1 && dy === 0) return "E";
    if (dx === -1 && dy === 0) return "W";
    if (dx === 0 && dy === 1) return "S";
    if (dx === 0 && dy === -1) return "N";
    return undefined;
}

/** Board extent, for steps that leave one side and arrive at the other. */
export interface BoardSize {
    width: number;
    height: number;
}

/**
 * Direction from `from` to `to` when the two are adjacent only by leaving the
 * board on one side and arriving on the other, or undefined.
 */
export function wrappedDirectionBetween(from: Vector, to: Vector, board: BoardSize): Direction | undefined {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dy === 0 && board.width > 2) {
        if (dx === board.width - 1) return "W";
        if (dx === -(board.width - 1)) return "E";
    }
    if (dx === 0 && board.height > 2) {
        if (dy === board.height - 1) return "N";
        if (dy === -(board.height - 1)) return "S";
    }
    return undefined;
}

export function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
