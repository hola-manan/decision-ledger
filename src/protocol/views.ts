/**
 * What the panel shows, as it crosses to the webview (api.md §1, "View types"). Fields are
 * nullable, never optional. Only display data: paths relative to the workspace, no byte
 * offsets, no log file paths, no file contents.
 */
import type { PanelError } from "./errors.js";

export interface SessionView {
  /** Claude Code session id. */
  id: string;
  /** The first prompt, one line, at most SESSION_TITLE_MAX_CHARS. */
  title: string;
  lastActivityAt: string;
  following: "auto" | "pinned";
  /** Other sessions in this workspace active recently. */
  otherActiveCount: number;
}

export interface LedgerView {
  branch: string | null;
  detachedAt: string | null;
  extractionEnabled: boolean;
}

export interface ExchangeView {
  /** The prompt's uuid. */
  id: string;
  prompt: { author: AuthorView; text: string; at: string };
  response: ResponseView;
  decisions: DecisionSectionView;
}

export interface AuthorView {
  kind: "human" | "ai";
  name: string;
}

export type EndReasonView = "done" | "stoppedByUser" | "error" | "incomplete";

export interface ResponseView {
  model: string | null;
  phase: "working" | "ended";
  /** Null while working. */
  endReason: EndReasonView | null;
  startedAt: string;
  /** Null while working: the webview ticks its own clock. */
  durationMs: number | null;
  /** The status line; null once ended. */
  activity: string | null;
  waiting: WaitingView | null;
  /** Claude Code's API error text when endReason is "error". */
  errorText: string | null;
  questions: QuestionView[];
  files: FileChangeView[];
  /** The full reply, in order. */
  reply: ReplyPartView[];
}

export interface WaitingView {
  kind: "question" | "permission";
  confidence: "certain" | "likely" | "possible";
  since: string;
  /** kind = question. */
  questionId: string | null;
  /** kind = permission: the command or file, read-only. */
  step: StepView | null;
}

export interface QuestionItemView {
  question: string;
  header: string | null;
  options: { label: string; description: string | null }[];
  multiSelect: boolean;
}

export interface QuestionView {
  /** The tool_use id, or "text:" + the exchange id. */
  id: string;
  source: "tool" | "text";
  items: QuestionItemView[];
  /** Null when not answered, or the answer isn't in the log. */
  answers: { question: string; answer: string }[] | null;
  answered: boolean;
}

export interface StepView {
  callId: string;
  tool: string;
  /** Display path, URL or pattern. */
  target: string | null;
  /** Bash: its first line, at most 200 characters. */
  command: string | null;
  description: string | null;
  diffStat: { added: number | null; removed: number | null } | null;
  outcome: "pending" | "ran" | "failed" | "denied";
}

export type ReplyPartView = { type: "text"; markdown: string } | { type: "step"; step: StepView };

export interface FileChangeView {
  /** Relative to the workspace; absolute if outside it. */
  path: string;
  kind: "added" | "modified";
  added: number | null;
  removed: number | null;
}

export type DecisionSectionState = "notYet" | "extracting" | "done" | "failed" | "noModel" | "configInvalid" | "off";

export interface DecisionSectionView {
  state: DecisionSectionState;
  /** Ordered by seq. */
  items: DecisionView[];
  /** Nodes that added these items, oldest first. */
  nodes: NodeRefView[];
  /** For failed / noModel / configInvalid. */
  error: PanelError | null;
}

export interface GradeView {
  name: string;
  grade: number;
  max: number;
  low: string | null;
  high: string | null;
}

export interface DecisionView {
  /** The record hash. */
  id: string;
  seq: number;
  decision: string;
  rationale: string | null;
  quote: string | null;
  author: AuthorView;
  grades: GradeView[];
  replaces: { id: string; seq: number; decision: string; authorName: string } | null;
}

export interface NodeRefView {
  id: string;
  shortId: string;
  branch: string | null;
}
