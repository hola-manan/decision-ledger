/**
 * The status line while Claude works: what it is doing right now (docs/ui/chat-panel.md,
 * "Status wording"). Pure. The webview truncates; the full text goes in a tooltip.
 */
import type { ToolCall } from "../claude-log";
import type { Exchange } from "./exchanges";
import { pendingCalls } from "./phase";

export const THINKING = "Thinking…";
export const WRITING_REPLY = "Writing the reply…";

/** How a path is shown, e.g. relative to the workspace. */
export type DisplayPath = (absolutePath: string) => string;

/** claude-log ends a command it cut short with "…"; the status line adds its own. */
const CUT_SHORT = /…$/;
/** Punctuation and spaces that would sit badly after a description, before the closing ellipsis. */
const TRAILING_STOPS = /[\s.…:;,]+$/;

type Wording = (call: ToolCall, show: DisplayPath) => string;

const fileOr = (call: ToolCall, show: DisplayPath, fallback: string) => (call.file ? show(call.file) : call.target ?? fallback);

const TOOL_WORDING: Record<string, Wording> = {
  Read: (c, show) => `Reading ${fileOr(c, show, "a file")}…`,
  Edit: (c, show) => `Editing ${fileOr(c, show, "a file")}…`,
  MultiEdit: (c, show) => `Editing ${fileOr(c, show, "a file")}…`,
  NotebookEdit: (c, show) => `Editing ${fileOr(c, show, "a notebook")}…`,
  // Whether the file exists only shows in the result, so a pending Write is "Writing".
  Write: (c, show) => `Writing ${fileOr(c, show, "a file")}…`,
  // Claude's descriptions read as instructions ("Run the tests"), so they stand alone.
  Bash: (c) => (c.description ? withEllipsis(c.description) : `Running ${(c.command ?? "a command").replace(CUT_SHORT, "")}…`),
  Grep: (c) => (c.target ? `Searching for "${c.target}"…` : "Searching the code…"),
  Glob: (c) => (c.target ? `Finding files matching ${c.target}…` : "Finding files…"),
  WebFetch: (c) => `Fetching ${c.target ? hostOf(c.target) : "a web page"}…`,
  WebSearch: () => "Searching the web…",
  Task: (c) => (c.description ? `Running a sub-agent: ${c.description}…` : "Running a sub-agent…"),
  Agent: (c) => (c.description ? `Running a sub-agent: ${c.description}…` : "Running a sub-agent…"),
  AskUserQuestion: () => "Asking you a question…",
  TodoWrite: () => "Updating the to-do list…",
};

/**
 * What Claude is doing in a working exchange: the oldest call still running (calls behind
 * it are queued, A15), else writing if text was the last thing it produced, else thinking.
 * The caller shows nothing once the exchange has ended.
 */
export function activityText(exchange: Exchange, show: DisplayPath = (p) => p): string {
  const running = pendingCalls(exchange)[0];
  if (running) return toolWording(running.call, show);
  const last = exchange.parts.at(-1);
  return last?.type === "text" && last.text.trim() ? WRITING_REPLY : THINKING;
}

function toolWording(call: ToolCall, show: DisplayPath): string {
  const wording = TOOL_WORDING[call.tool];
  if (wording) return wording(call, show);
  const target = call.file ? show(call.file) : call.target;
  return target ? `Using ${call.tool} on ${target}…` : `Using ${call.tool}…`;
}

/** "Run the tests." ends in one ellipsis, not two marks. */
function withEllipsis(text: string): string {
  return `${text.replace(TRAILING_STOPS, "")}…`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
