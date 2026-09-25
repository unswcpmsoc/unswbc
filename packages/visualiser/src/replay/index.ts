// Public surface for the replay format, plus the browser file dialogs both
// apps open it with.

export { ReplayError } from "./errors";
export type { ReplayErrorKind } from "./errors";

export { fetchReplaySource, fileDropReplaySource } from "./source";
export type { ByteProgress, ReplaySource } from "./source";

export { buildReplay, buildReplayAsync, loadReplay, loadReplayFromFile } from "./loader";
export { asDownloadProgress, asLoadProgress, DOWNLOAD_SHARE, resultLabel, TEAM_COLORS, verdict } from "./loader";
export type {
    GameEndReason,
    LoadedReplay,
    ReplayLoadPhase,
    ReplayLoadProgress,
    ReplayResult,
    TeamInfo,
    TeamStanding,
} from "./loader";

export { encodeReplay } from "./writer";
export { stripBotOutput, strippedView } from "./strip";
export type { ReplayInput } from "./writer";

export type { OpenedReplay } from "./opened";

export { downloadFile, openMapViaPicker, openReplayViaPicker, pickFile, saveMapAs, saveReplayAs } from "./browserFiles";
export type { OpenedMap } from "./browserFiles";
