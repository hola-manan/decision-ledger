/**
 * Is Claude Code waiting for the person? (data-model.md §2, "Waiting detection".) The log
 * only shows some waits for certain, so each answer says how sure it is. Pure.
 */
import { lastTextPart, type CallState, type Exchange } from "./exchanges";
import { pendingCalls, pendingQuestion, phaseOf } from "./phase";

/** A tool still running after this much quiet may be waiting for permission. */
export const PERMISSION_QUIET_MS = 3000;
/** Tools Claude Code runs without asking. */
export const TOOLS_THAT_NEVER_ASK: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "TodoWrite", "Task", "Agent"]);
/** Edit tools, which the acceptEdits mode lets through without asking. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const BYPASS_MODE = "bypassPermissions";
const ACCEPT_EDITS_MODE = "acceptEdits";
/** A question for the person: `?` at the end, before any closing quotes, brackets or markdown emphasis. */
const ENDS_WITH_QUESTION = /\?["'”’)\]*_]*$/;
/** A fence line left after removing complete blocks: the text ends inside an unclosed one. */
const FENCE_LINE = /^\s*(```|~~~)/m;
/** A complete fenced block, opening and closing fence included. */
const CLOSED_FENCED_BLOCK = /^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm;
const PARAGRAPH_BREAK = /\n\s*\n/;
export const TEXT_QUESTION_PREFIX = "text:";

export type WaitingConfidence = "certain" | "likely" | "possible";

export interface Waiting {
  kind: "question" | "permission";
  confidence: WaitingConfidence;
  /** When the wait began: the call's time, or the reply's last line for a text question. */
  since: string;
  /** The pending call's tool_use id, or "text:" + the exchange id for a question in the reply's text. */
  id: string;
}

/**
 * `now` and `quietSince` are epoch ms, as for phaseOf. An ended exchange (including one a
 * later prompt replaced) has no certain or possible wait; only a finished reply that ends
 * with a question can be a likely one.
 *
 * A15: Claude Code runs tools that change things one at a time, in order, so the call that
 * may be asking is the oldest pending one; calls queued behind it haven't been asked yet.
 */
export function detectWaiting(exchange: Exchange, now: number, quietSince: number): Waiting | null {
  const { phase, endReason } = phaseOf(exchange, now, quietSince);
  if (phase === "ended") return endReason === "done" && !exchange.isReplaced ? textQuestion(exchange) : null;
  const question = pendingQuestion(exchange);
  if (question) return { kind: "question", confidence: "certain", since: question.at || exchange.lastEntryAt, id: question.call.id };
  const oldest = pendingCalls(exchange)[0];
  if (!oldest || now - quietSince < PERMISSION_QUIET_MS || !mayAsk(oldest, exchange.prompt.permissionMode)) return null;
  return { kind: "permission", confidence: "possible", since: oldest.at || exchange.lastEntryAt, id: oldest.call.id };
}

/** Whether Claude Code could be asking permission for this call in this mode. */
function mayAsk({ call }: CallState, permissionMode: string | undefined): boolean {
  if (TOOLS_THAT_NEVER_ASK.has(call.tool) || permissionMode === BYPASS_MODE) return false;
  return !(EDIT_TOOLS.has(call.tool) && permissionMode === ACCEPT_EDITS_MODE);
}

/** The reply's last text ends its final paragraph with a question, outside any code block. */
function textQuestion(exchange: Exchange): Waiting | null {
  const text = lastTextPart(exchange);
  if (text === undefined || !endsWithQuestion(text)) return null;
  return { kind: "question", confidence: "likely", since: exchange.lastEntryAt, id: `${TEXT_QUESTION_PREFIX}${exchange.id}` };
}

function endsWithQuestion(text: string): boolean {
  const prose = text.replace(CLOSED_FENCED_BLOCK, "\n\n");
  if (FENCE_LINE.test(prose)) return false;
  const finalParagraph = prose.trim().split(PARAGRAPH_BREAK).at(-1) ?? "";
  return ENDS_WITH_QUESTION.test(finalParagraph.trim());
}
