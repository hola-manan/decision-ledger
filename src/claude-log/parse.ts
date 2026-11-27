/**
 * One JSONL line of a Claude Code session log → zero or more LogEntry. Every format
 * assumption lives here (or in tools.ts / harness.ts / discover.ts), cited by its id
 * in docs/architecture/data-model.md.
 */
import type { AssistantBlock, AssistantEntry, EntryBase, LogEntry, ToolResultEntry } from "./entries";
import { hasInterruptMarker, withoutHarnessText } from "./harness";
import { answersFromResult, asObject, fileChangeFromResult, isDenial, text, toToolCall } from "./tools";

/** A6: Claude Code's own notices are written as assistant messages from this model. */
const SYNTHETIC_MODEL = "<synthetic>";
const TOOL_USE_STOP = "tool_use";
const API_ERROR_FALLBACK = "API error";

type Json = Record<string, unknown>;

/**
 * Parses complete lines; `startOffset` is the byte position of the first line in its
 * file. A2: one JSON object per line, UTF-8, LF (a trailing CR is ignored). Malformed
 * and unknown lines produce nothing.
 */
export function parseLogLines(lines: string[], startOffset: number): LogEntry[] {
  const entries: LogEntry[] = [];
  let position = startOffset;
  for (const raw of lines) {
    const lineStart = position;
    position += Buffer.byteLength(raw, "utf8") + 1;
    entries.push(...parseLine(raw, lineStart, position));
  }
  return entries;
}

/** The one rule for "the reply is finished", shared by the watcher and the panel. */
export function isTurnEnd(entry: LogEntry): boolean {
  return entry.kind === "assistant" && !!entry.stopReason && entry.stopReason !== TOOL_USE_STOP;
}

function parseLine(raw: string, startOffset: number, endOffset: number): LogEntry[] {
  const line = parseJson(raw.replace(/\r$/, ""));
  if (!line || !isConversation(line)) return [];
  const base: EntryBase = {
    uuid: text(line.uuid) ?? "",
    sessionId: text(line.sessionId) ?? "",
    timestamp: text(line.timestamp) ?? "",
    startOffset,
    endOffset,
  };
  return line.type === "assistant" ? assistantEntries(line, base) : userEntries(line, base);
}

/**
 * A3: only "user" and "assistant" lines are conversation. A4: sidechain (sub-agent),
 * meta and compaction-summary lines aren't.
 */
function isConversation(line: Json): boolean {
  if (line.type !== "user" && line.type !== "assistant") return false;
  return !(line.isSidechain || line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly);
}

/**
 * A5: newer logs tag where a user line came from; only "human" (or no tag, in older logs)
 * was typed by the person. An allowlist, so an unknown future kind is never credited to them.
 * Tool results carry no tag and are kept whatever it says.
 */
function isTypedByPerson(line: Json): boolean {
  const originKind = asObject(line.origin).kind;
  return originKind === undefined || originKind === "human";
}

/** A6: one line per content block; synthetic notices are dropped unless they report an API error. */
function assistantEntries(line: Json, base: EntryBase): AssistantEntry[] {
  const message = asObject(line.message);
  const model = text(message.model);
  const common = { ...base, kind: "assistant" as const, messageId: text(message.id), stopReason: text(message.stop_reason) };
  if (model === SYNTHETIC_MODEL) {
    if (line.isApiErrorMessage !== true) return [];
    const notice = contentBlocks(message.content).map((b) => text(b.text) ?? "").join("\n").trim();
    return [withoutUndefined({ ...common, blocks: [], apiError: notice || API_ERROR_FALLBACK })];
  }
  const blocks = contentBlocks(message.content).flatMap(assistantBlock);
  return [withoutUndefined({ ...common, model, blocks })];
}

function assistantBlock(block: Json): AssistantBlock[] {
  if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
  if (block.type === "thinking" || block.type === "redacted_thinking") return [{ type: "thinking" }];
  if (block.type === "tool_use") return [{ type: "toolUse", call: toToolCall(block) }];
  return [];
}

/** A7, A11, A5: a user line holds tool results, an interrupt notice, or what the person typed. */
function userEntries(line: Json, base: EntryBase): LogEntry[] {
  const blocks = contentBlocks(asObject(line.message).content);
  const results = blocks.filter((b) => b.type === "tool_result");
  const entries: LogEntry[] = results.map((b) => toolResult(b, results.length === 1 ? line.toolUseResult : undefined, base));
  const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  if (texts.some(hasInterruptMarker)) entries.push({ ...base, kind: "interrupt" });
  const typed = isTypedByPerson(line) ? texts.map(withoutHarnessText).filter(Boolean).join("\n").trim() : "";
  if (typed) entries.push(withoutUndefined({ ...base, kind: "prompt" as const, text: typed, permissionMode: text(line.permissionMode) }));
  return entries;
}

/** `toolUseResult` describes the line's single result; with several results it can't be attributed. */
function toolResult(block: Json, toolUseResult: unknown, base: EntryBase): ToolResultEntry {
  const isError = block.is_error === true;
  const entry: ToolResultEntry = { ...base, kind: "toolResult", toolUseId: text(block.tool_use_id) ?? "", isError, rejected: isDenial(block.content) };
  if (!isError) {
    const fileChange = fileChangeFromResult(toolUseResult);
    if (fileChange) entry.fileChange = fileChange;
  }
  const answers = answersFromResult(toolUseResult);
  if (answers) entry.answers = answers;
  return entry;
}

function contentBlocks(content: unknown): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.map(asObject) : [];
}

function parseJson(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined; // A2: a malformed line is skipped, like an unknown one
  }
}

/** Optional fields are absent rather than undefined, so entries compare and serialise cleanly. */
function withoutUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}
