/** watcher: turns new Claude Code log entries into ledger records in the background. */
export { AgentWatcher } from "./watcher";
export { ExtractionPipeline, MAX_TURNS_PER_BATCH, MAX_CHARS_PER_TURN, type PipelineOptions } from "./pipeline";
export { toRawTurns, appendTurns } from "./turns";
export { readWatchState, writeWatchState, WATCH_STATE_FILE, type WatchState } from "./offsets";
export type { ExtractionStatus, ExtractionStatusProvider } from "./status";
