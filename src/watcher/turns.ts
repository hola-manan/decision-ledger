/**
 * Log entries → the human/AI turns the engine reads. Code isn't processed: tool calls
 * become a one-line note, and tool results, thinking and API-error notices are dropped.
 */
import * as path from "path";
import type { RawTurn } from "../core";
import { withoutHarnessText, type AssistantBlock, type LogEntry, type ToolCall } from "../claude-log";

/** Tools whose calls carry no information about decisions. */
const SILENT_TOOLS = new Set(["TodoWrite", "TaskCreate"]);

export function toRawTurns(entries: LogEntry[]): RawTurn[] {
  const turns: RawTurn[] = [];
  for (const entry of entries) {
    const turn = toRawTurn(entry);
    if (turn) appendTurn(turns, turn);
  }
  return turns;
}

/** Add turns read later (e.g. the next batch), applying the same merge rule across reads. */
export function appendTurns(turns: RawTurn[], more: RawTurn[]): void {
  for (const turn of more) appendTurn(turns, turn);
}

function toRawTurn(entry: LogEntry): RawTurn | undefined {
  if (entry.kind === "prompt") return turnFrom(entry, "human", entry.text);
  if (entry.kind !== "assistant" || entry.apiError !== undefined) return undefined;
  const text = entry.blocks.map(blockText).filter(Boolean).join("\n").trim();
  return text ? { ...turnFrom(entry, "ai", text), name: entry.model } : undefined;
}

function turnFrom(entry: LogEntry, author: RawTurn["author"], text: string): RawTurn {
  return {
    author,
    text,
    externalId: entry.uuid,
    timestamp: entry.timestamp || new Date().toISOString(),
    session: entry.sessionId,
    endOffset: entry.endOffset,
  };
}

function blockText(block: AssistantBlock): string {
  if (block.type === "text") return withoutHarnessText(block.text);
  if (block.type === "toolUse") return toolNote(block.call);
  return "";
}

function toolNote(call: ToolCall): string {
  if (call.file) return `[${call.tool} ${path.basename(call.file)}]`;
  if (call.tool === "Bash" && call.description) return `[ran: ${call.description}]`;
  if (SILENT_TOOLS.has(call.tool)) return "";
  return `[${call.tool}]`;
}

/** Consecutive AI fragments (the text between an agent's tool calls) form one turn. */
function appendTurn(turns: RawTurn[], turn: RawTurn): void {
  const prev = turns[turns.length - 1];
  if (prev?.author === "ai" && turn.author === "ai") {
    prev.text += "\n" + turn.text;
    prev.name ??= turn.name;
    // Chunks of one source turn share an endOffset (see core/batches); move them all
    // together, or a batch could end between them and save an offset past unsent text.
    const oldEnd = prev.endOffset;
    for (let i = turns.length - 1; i >= 0 && turns[i].endOffset === oldEnd; i--) turns[i].endOffset = turn.endOffset;
    return;
  }
  turns.push({ ...turn });
}
