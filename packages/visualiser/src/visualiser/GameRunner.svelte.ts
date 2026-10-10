import type Match from "./Match";
import type { Granularity } from "./Match";
import type { TeamId } from "./Schema";
import { DEFAULT_STAGGER } from "./constants";
import { persistSettings, settings } from "../settings.svelte";

/** Playback controller. `position` is a float step index; the rAF loop ticks it. */
export default class GameRunner {
    /** Current step position; fractional part = progress through the step. */
    position = $state(0);
    playing = $state(false);
    /** Steps per second. Starts at the last speed used. */
    speed = $state(settings.speed);
    /** Wrap to start on reaching the end. */
    loop = $state(false);
    /** What one step advances by. Positions are indices in this granularity. */
    granularity = $state<Granularity>("round");
    /** How far apart a round's turns start when stepping by round; see `DEFAULT_STAGGER`. */
    stagger = $state(DEFAULT_STAGGER);
    /** Last seekable position for the current granularity, refreshed each tick. */
    end = $state(0);
    /** Dragons currently included in the game-log selection filter. */
    selectedDragonIds = $state<number[]>([]);
    /** The dragon the camera keeps in view, if any. */
    followDragonId = $state<number | undefined>();
    /** The viewer's own team in this match, when the host knows it. */
    ownTeam = $state<TeamId | undefined>();
    /** Whose bot output (indicators, drawings, log lines) to show; both when unset. */
    outputTeam = $state<TeamId | undefined>();

    #match: Match;

    constructor(match: Match) {
        this.#match = match;
        this.granularity = settings.granularity;
        this.end = match.endFor(this.granularity);
    }

    /** Change speed and remember it for the next replay. */
    setSpeed(speed: number): void {
        this.speed = speed;
        settings.speed = speed;
        persistSettings();
    }

    get match(): Match {
        return this.#match;
    }

    /** The round being shown, whatever granularity positions are counted in. */
    get round(): number {
        return this.#match.roundOf(this.position, this.granularity);
    }

    /** Switch granularity, landing at the start of the round you were on. */
    setGranularity(granularity: Granularity): void {
        if (granularity === this.granularity) return;
        this.playing = false;
        const atEnd = this.position >= this.end;
        const round = this.round;
        this.granularity = granularity;
        settings.granularity = granularity;
        persistSettings();
        this.end = this.#match.endFor(granularity);
        this.position = atEnd ? this.end : this.#match.positionOf(round, 0, granularity);
    }

    get atEnd(): boolean {
        return this.position >= this.end;
    }

    /** Advance by `dt` seconds. Called each frame by the Visualiser. */
    tick(dt: number): void {
        this.end = this.#match.endFor(this.granularity);
        if (!this.playing) return;
        this.position += dt * this.speed;
        if (this.position >= this.end) {
            if (this.loop) {
                this.position = 0;
            } else {
                this.position = this.end;
                this.playing = false;
            }
        }
    }

    play(): void {
        if (this.position >= this.end) this.position = 0;
        this.playing = true;
    }

    /** Pause and snap to the nearest whole step. */
    pause(): void {
        this.playing = false;
        this.position = Math.max(0, Math.min(Math.round(this.position), this.end));
    }

    toggle(): void {
        if (this.playing) this.pause();
        else this.play();
    }

    /** Jump to a position clamped to [0, end]. */
    seek(position: number): void {
        this.position = Math.max(0, Math.min(position, this.end));
    }

    /** Jump by whole steps (negative rewinds). */
    step(steps: number): void {
        this.playing = false;
        this.seek(Math.round(this.position) + steps);
    }

    restart(): void {
        this.position = 0;
    }
}
