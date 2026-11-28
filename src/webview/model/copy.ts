/**
 * The webview's words: titles per error code and the waiting and section wording. The
 * extension writes each error's facts (PanelError.message); the webview owns the titles
 * (api.md §2). No DOM.
 */
import type { DecisionSectionState, PanelAction, PanelErrorCode, WaitingView } from "../../protocol/index.js";

export const ERROR_TITLES: Record<PanelErrorCode, string> = {
  NO_SESSION_FOUND: "No Claude Code session found for this workspace",
  SESSION_UNREADABLE: "Can't read this Claude Code session",
  LOG_FORMAT_UNRECOGNIZED: "This Claude Code version writes a log the panel can't read",
  LEDGER_UNREADABLE: "Can't read the ledger",
  EXTRACTION_API_FAILED: "Couldn't extract decisions",
  EXTRACTION_REPLY_UNREADABLE: "Couldn't extract decisions",
  NO_MODEL: "No model to extract decisions",
  LEDGER_CONFIG_INVALID: "The decision parameters can't be used",
  EXTRACTION_FAILED: "Couldn't extract decisions",
  EXTRACTION_OFF: "Agent watching is off",
  NOT_FOUND: "Not found",
  ACTION_FAILED: "That didn't work",
  INVALID_MESSAGE: "Something went wrong in the panel",
  PROTOCOL_VERSION_MISMATCH: "The panel needs to reload",
};

export const ACTION_LABELS: Record<PanelAction, string> = {
  retryExtraction: "Retry now",
  setUpModel: "Set up a model",
  editParameters: "Edit Decision Parameters",
  enableExtraction: "Turn on agent watching",
  rescanSessions: "Check again",
  chooseSession: "Switch session",
  openOutput: "Show details",
};

/** Under the "no session" title: what to do next, depending on whether Claude Code is installed. */
export function noSessionHint(claudeCodeInstalled: boolean): string {
  return claudeCodeInstalled
    ? "Start a conversation with Claude Code in this workspace. This panel follows it as you type."
    : "Install the Claude Code extension, start a conversation in this workspace, then check again.";
}

export function waitingText(waiting: Pick<WaitingView, "kind" | "confidence">): string {
  if (waiting.kind === "permission") return "Claude Code may be waiting for your permission";
  return waiting.confidence === "certain" ? "Waiting for your answer in Claude Code" : "Claude asked you a question";
}

export const SECTION_TEXT: Record<DecisionSectionState, string> = {
  notYet: "Decisions so far",
  extracting: "Extracting…",
  done: "Decisions",
  failed: "Couldn't extract decisions",
  noModel: "No model to extract decisions",
  configInvalid: "The decision parameters can't be used",
  off: "Agent watching is off. Decisions aren't being extracted.",
};

export const EMPTY_SESSION_TEXT = {
  title: "Waiting for your first message",
  body: "Type in Claude Code. Each reply shows up here as what matters: questions, decisions, files changed, and the full reply one click away.",
};
