/**
 * Whether an exchange is still being worked on, and if not, how it ended (data-model.md §2,
 * "Derived values"). Pure: the caller passes the clock.
 */
import { isTurnEnd } from "../claude-log";
import type { CallState, Exchange } from "./exchanges";

/** A reply with no new line for this long is shown as incomplete; more lines bring it back. */
export const STALE_EXCHANGE_MS = 10 * 60 * 1000;
/** This tool always blocks on the person, so while it is pending the exchange is never stale. */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export type EndReason = "done" | "stoppedByUser" | "error" | "incomplete";

export interface Phase {
  phase: "working" | "ended";
  endReason: EndReason | null;
}

/**
 * `now` and `quietSince` are epoch ms; `quietSince` is when the session file last grew.
 * Checked in order: interrupted, API error, finished reply, replaced by a later prompt
 * (the rest of the log belongs to the newer exchange), stale.
 */
export function phaseOf(exchange: Exchange, now: number, quietSince: number): Phase {
  if (exchange.interrupted) return ended("stoppedByUser");
  const last = exchange.lastAssistant;
  if (last?.apiError !== undefined) return ended("error");
  if (last && isTurnEnd(last) && !hasPendingCall(exchange)) return ended("done");
  if (exchange.isReplaced) return ended("incomplete");
  if (now - quietSince >= STALE_EXCHANGE_MS && !hasPendingQuestion(exchange)) return ended("incomplete");
  return { phase: "working", endReason: null };
}

/** Calls with no result yet, oldest first. */
export function pendingCalls(exchange: Exchange): CallState[] {
  return [...exchange.calls.values()].filter((state) => !state.result);
}

export function hasPendingCall(exchange: Exchange): boolean {
  return pendingCalls(exchange).length > 0;
}

/** A question Claude asked with AskUserQuestion that has no answer yet: a certain wait. */
export function pendingQuestion(exchange: Exchange): CallState | undefined {
  return pendingCalls(exchange).find((state) => state.call.tool === ASK_USER_QUESTION_TOOL);
}

export function hasPendingQuestion(exchange: Exchange): boolean {
  return pendingQuestion(exchange) !== undefined;
}

function ended(endReason: EndReason): Phase {
  return { phase: "ended", endReason };
}
