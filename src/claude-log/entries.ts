/**
 * What the rest of the extension knows about a Claude Code session log. Nothing outside
 * claude-log sees raw JSON, and no entry carries file contents, patches or tool output.
 */

export interface EntryBase {
  /** The line's uuid (A4). */
  uuid: string;
  sessionId: string;
  /** ISO 8601, or "" when the line has none. */
  timestamp: string;
  /** Byte offset of the line's start in its file. */
  startOffset: number;
  /** Byte offset just past the line's newline. */
  endOffset: number;
}

export type LogEntry = PromptEntry | AssistantEntry | ToolResultEntry | InterruptEntry;

/** A message the person typed (A5). Harness elements are removed; it may contain code. */
export interface PromptEntry extends EntryBase {
  kind: "prompt";
  text: string;
  permissionMode?: string;
}

export interface AssistantEntry extends EntryBase {
  kind: "assistant";
  /** Shared by every line of one model message (A6). */
  messageId?: string;
  /** Never "<synthetic>". */
  model?: string;
  blocks: AssistantBlock[];
  /** "tool_use" while tools follow; "end_turn", "stop_sequence", … at the end; absent mid-message. */
  stopReason?: string;
  /** Set, with no blocks, when this is Claude Code's API-error notice (A6). */
  apiError?: string;
}

export type AssistantBlock =
  /** As Claude wrote it, code included. Display only: it reaches a model only through code stripping. */
  | { type: "text"; text: string }
  /** Content dropped. */
  | { type: "thinking" }
  | { type: "toolUse"; call: ToolCall };

export interface ToolCall {
  /** The tool_use id. */
  id: string;
  /** "Bash", "Edit", "AskUserQuestion", … */
  tool: string;
  /** The file the tool works on (file_path, path or notebook_path), as logged. */
  file?: string;
  /** What to show for the call: the file, URL, search pattern or sub-agent description. */
  target?: string;
  /** Bash only, exact. */
  command?: string;
  /** Claude's short description (Bash, Task, Agent). */
  description?: string;
  /** AskUserQuestion only. */
  questions?: AskedQuestion[];
  /** Edit, MultiEdit, Write, NotebookEdit: counted from the input, a fallback for the result's counts. */
  edit?: FileChangeFact;
}

export interface AskedQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

export interface FileChangeFact {
  /** Absolute, as logged. */
  path: string;
  kind: "added" | "modified";
  /** Lines; absent when unknown (NotebookEdit). */
  added?: number;
  removed?: number;
}

export interface ToolResultEntry extends EntryBase {
  kind: "toolResult";
  toolUseId: string;
  isError: boolean;
  /** The person denied the tool in Claude Code (A9). */
  rejected: boolean;
  /** From toolUseResult; more exact than ToolCall.edit (A7). */
  fileChange?: FileChangeFact;
  /** AskUserQuestion (A10). */
  answers?: { question: string; answer: string }[];
}

/** "[Request interrupted by user…]" (A11). */
export interface InterruptEntry extends EntryBase {
  kind: "interrupt";
}
