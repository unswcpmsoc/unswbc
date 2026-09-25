export type ReplayErrorKind = "not-found" | "unfinished" | "network" | "schema-mismatch" | "invalid";

export class ReplayError extends Error {
    constructor(
        public readonly kind: ReplayErrorKind,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = "ReplayError";
    }
}
