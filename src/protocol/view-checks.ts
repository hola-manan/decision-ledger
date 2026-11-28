/**
 * Checks for the view types. The assertions at the end make each check produce exactly its
 * view type: a field missing, extra, looser or stricter on either side fails to compile, so
 * views.ts and these checks can't drift apart (a drifted check would make the webview
 * reject every message).
 */
import { PANEL_ACTIONS, PANEL_ERROR_CODES, type PanelError } from "./errors.js";
import { array, bool, int, literal, nullable, num, object, record, scalar, str, tagged, type Checked, type Same } from "./schema.js";
import type {
  AuthorView,
  DecisionSectionView,
  DecisionView,
  ExchangeView,
  FileChangeView,
  LedgerView,
  NodeRefView,
  QuestionView,
  ReplyPartView,
  ResponseView,
  SessionView,
  StepView,
  WaitingView,
} from "./views.js";

export const panelError = object({
  code: literal(...PANEL_ERROR_CODES),
  message: str,
  details: nullable(record(scalar)),
  actions: array(literal(...PANEL_ACTIONS)),
});

export const sessionView = object({
  id: str,
  title: str,
  lastActivityAt: str,
  following: literal("auto", "pinned"),
  otherActiveCount: int,
});

export const ledgerView = object({ branch: nullable(str), detachedAt: nullable(str), extractionEnabled: bool });

const authorView = object({ kind: literal("human", "ai"), name: str });

const stepView = object({
  callId: str,
  tool: str,
  target: nullable(str),
  command: nullable(str),
  description: nullable(str),
  diffStat: nullable(object({ added: nullable(int), removed: nullable(int) })),
  outcome: literal("pending", "ran", "failed", "denied"),
});

const waitingView = object({
  kind: literal("question", "permission"),
  confidence: literal("certain", "likely", "possible"),
  since: str,
  questionId: nullable(str),
  step: nullable(stepView),
});

const questionView = object({
  id: str,
  source: literal("tool", "text"),
  items: array(
    object({
      question: str,
      header: nullable(str),
      options: array(object({ label: str, description: nullable(str) })),
      multiSelect: bool,
    })
  ),
  answers: nullable(array(object({ question: str, answer: str }))),
  answered: bool,
});

const fileChangeView = object({ path: str, kind: literal("added", "modified"), added: nullable(int), removed: nullable(int) });

const replyPartView = tagged("type", { text: object({ markdown: str }), step: object({ step: stepView }) });

const responseView = object({
  model: nullable(str),
  phase: literal("working", "ended"),
  endReason: nullable(literal("done", "stoppedByUser", "error", "incomplete")),
  startedAt: str,
  durationMs: nullable(num),
  activity: nullable(str),
  waiting: nullable(waitingView),
  errorText: nullable(str),
  questions: array(questionView),
  files: array(fileChangeView),
  reply: array(replyPartView),
});

const decisionView = object({
  id: str,
  seq: int,
  decision: str,
  rationale: nullable(str),
  quote: nullable(str),
  author: authorView,
  grades: array(object({ name: str, grade: num, max: num, low: nullable(str), high: nullable(str) })),
  replaces: nullable(object({ id: str, seq: int, decision: str, authorName: str })),
});

const nodeRefView = object({ id: str, shortId: str, branch: nullable(str) });

const decisionSectionView = object({
  state: literal("notYet", "extracting", "done", "failed", "noModel", "configInvalid", "off"),
  items: array(decisionView),
  nodes: array(nodeRefView),
  error: nullable(panelError),
});

export const exchangeView = object({
  id: str,
  prompt: object({ author: authorView, text: str, at: str }),
  response: responseView,
  decisions: decisionSectionView,
});

// ---------- exactness, checked at compile time ----------

type Exactly<C, View> = Same<Checked<C>, View>;
export const CHECKS_MATCH_VIEWS: [
  Exactly<typeof panelError, PanelError>,
  Exactly<typeof sessionView, SessionView>,
  Exactly<typeof ledgerView, LedgerView>,
  Exactly<typeof authorView, AuthorView>,
  Exactly<typeof stepView, StepView>,
  Exactly<typeof waitingView, WaitingView>,
  Exactly<typeof questionView, QuestionView>,
  Exactly<typeof fileChangeView, FileChangeView>,
  Exactly<typeof replyPartView, ReplyPartView>,
  Exactly<typeof responseView, ResponseView>,
  Exactly<typeof decisionView, DecisionView>,
  Exactly<typeof nodeRefView, NodeRefView>,
  Exactly<typeof decisionSectionView, DecisionSectionView>,
  Exactly<typeof exchangeView, ExchangeView>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];

// Proof the assertion bites: a check that allows null where the view doesn't is not the same type.
// @ts-expect-error a looser check is not exactly the view
const LOOSER_CHECK_FAILS: Exactly<ReturnType<typeof nullable<string>>, string> = true;
void LOOSER_CHECK_FAILS;
