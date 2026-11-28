/**
 * Exchange + derived values + linked records → the view the webview renders (data-model.md
 * §4). Pure. Only display data crosses: no byte offsets, no log paths, null not undefined.
 */
import { GRADE_MAX, shortHash, type NamedGrade } from "../core";
import type { DecisionSectionState, DecisionSectionView, DecisionView, ExchangeView, QuestionView, ReplyPartView, ResponseView, StepView, WaitingView } from "../protocol";
import { activityText } from "./activity";
import type { CallState, Exchange } from "./exchanges";
import { toPanelError } from "./errors";
import { collectFileChanges } from "./files";
import type { LinkedDecision } from "./linker";
import { displayPath } from "./paths";
import { ASK_USER_QUESTION_TOOL, phaseOf, type Phase } from "./phase";
import { closingQuestion, detectWaiting, TEXT_QUESTION_PREFIX, type Waiting } from "./waiting";

/** What depends on the clock; computed once per render and shared with the badge and section state. */
export interface Derived {
  phase: Phase;
  waiting: Waiting | null;
}

export function deriveExchange(exchange: Exchange, now: number, quietSince: number): Derived {
  return { phase: phaseOf(exchange, now, quietSince), waiting: detectWaiting(exchange, now, quietSince) };
}

export interface ExchangeViewInput {
  exchange: Exchange;
  derived: Derived;
  decisions: DecisionSectionView;
  /** The person at this machine: the author of every prompt. */
  humanName: string;
  workspace: string;
}

export function toExchangeView({ exchange, derived, decisions, humanName, workspace }: ExchangeViewInput): ExchangeView {
  const show = (file: string) => displayPath(file, workspace);
  return {
    id: exchange.id,
    prompt: { author: { kind: "human", name: humanName }, text: exchange.prompt.text, at: exchange.prompt.timestamp },
    response: responseView(exchange, derived, show),
    decisions,
  };
}

function responseView(exchange: Exchange, { phase, waiting }: Derived, show: (file: string) => string): ResponseView {
  const isWorking = phase.phase === "working";
  return {
    model: exchange.model ?? null,
    phase: phase.phase,
    endReason: phase.endReason,
    startedAt: exchange.prompt.timestamp,
    durationMs: isWorking ? null : durationMs(exchange.prompt.timestamp, exchange.lastEntryAt),
    activity: isWorking ? activityText(exchange, show) : null,
    waiting: waiting ? waitingView(exchange, waiting, show) : null,
    errorText: phase.endReason === "error" ? exchange.lastAssistant?.apiError ?? null : null,
    questions: questionViews(exchange, phase),
    files: collectFileChanges(exchange).map((f) => ({ path: show(f.path), kind: f.kind, added: f.added ?? null, removed: f.removed ?? null })),
    reply: replyViews(exchange, show),
  };
}

/** Null when either time is missing or unreadable, rather than NaN. */
function durationMs(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function waitingView(exchange: Exchange, waiting: Waiting, show: (file: string) => string): WaitingView {
  const call = waiting.kind === "permission" ? exchange.calls.get(waiting.id) : undefined;
  return {
    kind: waiting.kind,
    confidence: waiting.confidence,
    since: waiting.since,
    questionId: waiting.kind === "question" ? waiting.id : null,
    step: call ? stepView(call, show) : null,
  };
}

/** Every AskUserQuestion call, then a question a finished reply's text closed with (answered by the next prompt). */
function questionViews(exchange: Exchange, phase: Phase): QuestionView[] {
  const views: QuestionView[] = [];
  for (const { call, result } of exchange.calls.values()) {
    if (call.tool !== ASK_USER_QUESTION_TOOL) continue;
    views.push({
      id: call.id,
      source: "tool",
      items: (call.questions ?? []).map((q) => ({
        question: q.question,
        header: q.header ?? null,
        options: q.options.map((o) => ({ label: o.label, description: o.description ?? null })),
        multiSelect: q.multiSelect,
      })),
      answers: result?.answers ?? null,
      answered: !!result && !result.isError,
    });
  }
  const closing = phase.endReason === "done" ? closingQuestion(exchange) : null;
  if (closing !== null) {
    views.push({
      id: `${TEXT_QUESTION_PREFIX}${exchange.id}`,
      source: "text",
      items: [{ question: closing, header: null, options: [], multiSelect: false }],
      answers: null,
      answered: exchange.isReplaced,
    });
  }
  return views;
}

function replyViews(exchange: Exchange, show: (file: string) => string): ReplyPartView[] {
  return exchange.parts.flatMap((part): ReplyPartView[] => {
    if (part.type === "text") return part.text.trim() ? [{ type: "text", markdown: part.text }] : [];
    const call = exchange.calls.get(part.callId);
    return call ? [{ type: "step", step: stepView(call, show) }] : [];
  });
}

function stepView({ call, result }: CallState, show: (file: string) => string): StepView {
  const change = (result && !result.isError ? result.fileChange : undefined) ?? call.edit;
  return {
    callId: call.id,
    tool: call.tool,
    target: call.file ? show(call.file) : call.target ?? null,
    command: call.command ?? null,
    description: call.description ?? null,
    diffStat: change ? { added: change.added ?? null, removed: change.removed ?? null } : null,
    outcome: !result ? "pending" : result.rejected ? "denied" : result.isError ? "failed" : "ran",
  };
}

// ---------- decisions ----------

export interface DecisionSectionInput {
  state: DecisionSectionState;
  linked: readonly LinkedDecision[];
  /** The current branch, or null when HEAD is detached. */
  branch: string | null;
  /** The watcher's failure for this file, shown for failed / noModel / configInvalid. */
  failure: { error: unknown; retryAt: number | null } | null;
}

const ERROR_STATES: ReadonlySet<DecisionSectionState> = new Set(["failed", "noModel", "configInvalid"]);

export function toDecisionSectionView({ state, linked, branch, failure }: DecisionSectionInput): DecisionSectionView {
  const nodes = [...new Set(linked.map((d) => d.nodeHash))].map((id) => ({ id, shortId: shortHash(id), branch }));
  return {
    state,
    items: linked.map(decisionView),
    nodes,
    error: ERROR_STATES.has(state) && failure ? toPanelError(failure.error, { scope: "section", retryAt: failure.retryAt }) : null,
  };
}

function decisionView({ hash, record, grades, replaces }: LinkedDecision): DecisionView {
  return {
    id: hash,
    seq: record.seq,
    decision: record.decision,
    rationale: record.rationale ?? null,
    quote: record.source.quote ?? null,
    author: { kind: record.author.kind, name: record.author.name },
    grades: grades.map(gradeView),
    replaces: replaces ? { id: replaces.hash, seq: replaces.seq, decision: replaces.decision, authorName: replaces.authorName } : null,
  };
}

function gradeView(grade: NamedGrade) {
  return { name: grade.name, grade: grade.grade, max: GRADE_MAX, low: grade.low ?? null, high: grade.high ?? null };
}
