/** claude-log: the only code that knows Claude Code's session log format. */
export type {
  AskedQuestion,
  AssistantBlock,
  AssistantEntry,
  EntryBase,
  FileChangeFact,
  InterruptEntry,
  LogEntry,
  PromptEntry,
  ToolCall,
  ToolResultEntry,
} from "./entries";
export { parseLogLines, isTurnEnd } from "./parse";
export { withoutHarnessText } from "./harness";
export { comparablePath, findSessionFiles, isInsideWorkspace, sessionIdOf } from "./discover";
export { Listeners, type Unsubscribe } from "./listeners";
export {
  createSessionLogSource,
  PollingSessionLogSource,
  LIVE_POLL_MS,
  DRIFT_MIN_LINES,
  type LogBatch,
  type SessionFile,
  type SessionLogSource,
  type SessionLogSourceOptions,
  type SourceFailure,
} from "./source";
