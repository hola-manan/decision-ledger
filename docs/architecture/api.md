# API contracts

There is no HTTP API. The contracts are:

1. **The extension↔webview protocol** (`src/protocol/`): the panel's equivalent of a REST API.
2. **The error format** used by that protocol.
3. **Internal interfaces** between modules.

The engine contract (`engine/src/contract.ts`) is fixed and not repeated here. The only proposed change to it is in section 5.

---

## 1. Extension↔webview protocol

### Conventions

- **Envelope:** every message is a JSON object `{ v: 1, type: "...", ... }`. `v` is `PROTOCOL_VERSION`.
- **Naming:** camelCase fields; message `type`s are camelCase verbs or nouns (D-019).
- **Nullable, never optional:** view fields are always present, with `null` when there's no value. That makes validators simple and rendering explicit.
- **Validation at both edges.** The webview runs `parseHostMessage(raw)` on everything it receives, and the extension runs `parseWebviewMessage(raw)`. Both are hand-written validators in `src/protocol/validate.ts` (no schema library, D-013). An invalid message is dropped and logged: the webview posts `protocolError`, and the extension writes to the "Decision Ledger" output channel. Unknown fields are stripped.
- **Versioning:** additive changes (a new optional message type, a new field that old receivers can ignore) keep `v`. Removing or changing the meaning of a field bumps `v`. The extension and webview ship in one bundle, so a mismatch only means a stale webview. The webview then shows `PROTOCOL_VERSION_MISMATCH` with a "Reload the panel" button that posts `reloadRequest`, and the host re-renders its HTML. (It doesn't reload by itself: a mismatch that persisted would loop.)
- **Order:** the host sends nothing until it receives `ready`, then sends exactly one `snapshot` before any `exchangeUpserted`. The webview ignores updates received before its first snapshot.
- **Throttling:** upserts are coalesced per exchange, at most one per `LIVE_UPDATE_MIN_INTERVAL_MS` (250 ms). A snapshot replaces all webview data.
- **What never crosses:** API keys, model replies, byte offsets, log file paths, file contents or patches, stack traces.

### Filter view (D-021): a deliberate, lighter contract

The Filter view (`src/protocol/filter.ts`) is a separate, tiny webview that ships in the same bundle as the extension. It follows the validation rule above (`parseFilterMessage` in the extension, `parseFilterHostMessage` in the webview; invalid messages are dropped and the extension logs them) but not the rest:
- **No `v` envelope.** Both ends always ship together, and nothing is persisted in the webview, so there is no stale-webview case to detect.
- **No `requestId` / `actionResult`.** Every action's result is the next `state` message.
- **Its own error message, `{ type: "error", message }`, instead of `PanelError`.** The only error the view shows is "the parameters can't be read": a `ConfigError`'s text, or a fixed sentence for anything else (whose details go to the output channel). It has one fixed action, "Edit Decision Parameters".

| Direction | `type` | Payload |
|---|---|---|
| host → webview | `state` | `scale`, `parameters` (`id`, `name`, `low?`, `high?`), `ranges` (one per parameter), `isActive`, `shown`, `total` |
| host → webview | `error` | `message` |
| webview → host | `ready` | none; the host answers with `state` or `error` |
| webview → host | `setRange` | `id`, `range` (`min`, `max`, whole grades; the host clamps them) |
| webview → host | `reset` | none |
| webview → host | `editParameters` | none; runs `ledger.editParameters` |

If the panel protocol later adopts a shared envelope helper, the filter moves onto it in the same change.

### Host → webview

| `type` | When | Payload |
|---|---|---|
| `snapshot` | After `ready`; on session switch, branch switch, extraction on/off, or a panel-level problem | `session`, `exchanges` (oldest first, latest `MAX_SNAPSHOT_EXCHANGES` = 30), `hasEarlier`, `ledger`, `problem` |
| `exchangeUpserted` | An exchange changed (new log lines, waiting timer fired, decisions committed, extraction status changed) | `exchange: ExchangeView` (the whole exchange, replacing any with the same `id`) |
| `exchangesPrepended` | Reply to `loadEarlier` | `exchanges` (oldest first), `hasEarlier` |
| `actionResult` | Reply to any webview action | `requestId`, `ok`, `error: PanelError \| null` |

### Webview → host

All actions carry `requestId` (a string unique per webview lifetime) and get one `actionResult`.

| `type` | Payload | Does | Errors |
|---|---|---|---|
| `ready` | none | The webview has loaded; the host sends `snapshot` | none |
| `openRecord` | `recordId` | Runs `ledger.openRecord` (record view in an editor tab) | `NOT_FOUND` if the record isn't in the current snapshot |
| `revealNode` | `nodeId` | Reveals the node in the Decisions tree | `NOT_FOUND` |
| `openFile` | `exchangeId`, `path` | Opens the file in an editor | `NOT_FOUND` if `path` isn't a file row of that exchange; `ACTION_FAILED` if the file is gone |
| `retryExtraction` | none | `watcher.retryNow()`: clears backoff and runs a pass now | `EXTRACTION_OFF` |
| `setUpModel` | none | Quick pick: Use GitHub Copilot Chat · Set Anthropic API key · Set Vertex AI (Gemini) key (`ledger.setUpModel`) | none (cancelling is `ok`) |
| `editParameters` | none | Runs `ledger.editParameters` | none |
| `enableExtraction` | none | Turns agent watching on | none |
| `chooseSession` | none | Quick pick of this workspace's sessions; picking one pins it | `NO_SESSION_FOUND` |
| `followLatest` | none | Unpins; follows the newest prompt | none |
| `rescanSessions` | none | Discovers session files now ("Check again") | none |
| `loadEarlier` | `beforeExchangeId` | Sends `exchangesPrepended` | `NOT_FOUND` |
| `openOutput` | none | Shows the output channel | none |
| `protocolError` | `receivedType: string \| null`, `reason` | Logged by the host; no reply | none |
| `reloadRequest` | none | Host re-renders the webview HTML; no reply | none |

**Reserved, not accepted in v1:** `saveDecision { exchangeId, partIndex, quote }` for "save a missed sentence as a decision" (D-016). Until it's implemented, the validator rejects it.

### View types (`src/protocol/views.ts`)

```ts
interface SnapshotMessage {
  v: 1; type: "snapshot";
  session: SessionView | null;      // null with problem NO_SESSION_FOUND
  exchanges: ExchangeView[];
  hasEarlier: boolean;
  ledger: LedgerView;
  problem: PanelError | null;       // panel-level problems only (see catalog "Scope: panel")
}

interface SessionView {
  id: string;                       // Claude Code session id
  title: string;                    // first prompt, one line, ≤ 60 chars
  lastActivityAt: string;           // ISO
  following: "auto" | "pinned";
  otherActiveCount: number;         // other sessions in this workspace active in the last 30 min
}

interface LedgerView { branch: string | null; detachedAt: string | null; extractionEnabled: boolean }

interface ExchangeView {
  id: string;                       // prompt uuid
  prompt: { author: AuthorView; text: string; at: string };
  response: ResponseView;
  decisions: DecisionSectionView;
}

interface AuthorView { kind: "human" | "ai"; name: string }

interface ResponseView {
  model: string | null;
  phase: "working" | "ended";
  endReason: "done" | "stoppedByUser" | "error" | "incomplete" | null;   // null while working
  startedAt: string;
  durationMs: number | null;        // null while working (the webview ticks its own clock)
  activity: string | null;          // status line, e.g. "Running npm test…"; null when ended
  waiting: WaitingView | null;
  errorText: string | null;         // Claude Code's API error text when endReason = "error"
  questions: QuestionView[];
  files: FileChangeView[];
  reply: ReplyPartView[];           // the full, unprocessed reply in order (shown live while working)
}

interface WaitingView {
  kind: "question" | "permission";
  confidence: "certain" | "likely" | "possible";
  since: string;
  questionId: string | null;        // kind = question
  step: StepView | null;            // kind = permission: the exact command or file, read-only
}

interface QuestionView {
  id: string;                       // tool_use id, or "text:" + exchange id
  source: "tool" | "text";
  items: { question: string; header: string | null; options: { label: string; description: string | null }[]; multiSelect: boolean }[];
  answers: { question: string; answer: string }[] | null;   // null when not answered or not in the log
  answered: boolean;
}

interface StepView {
  callId: string;
  tool: string;                     // "Bash", "Edit", …
  target: string | null;            // display path, URL, pattern
  command: string | null;           // Bash: its first line, at most 200 characters, as claude-log keeps it
  description: string | null;       // Claude's short description
  diffStat: { added: number | null; removed: number | null } | null;
  outcome: "pending" | "ran" | "failed" | "denied";
}

type ReplyPartView = { type: "text"; markdown: string } | { type: "step"; step: StepView };

interface FileChangeView {
  path: string;                     // relative to the workspace; absolute if outside it
  kind: "added" | "modified";
  added: number | null;
  removed: number | null;
}

interface DecisionSectionView {
  state: "notYet" | "extracting" | "done" | "failed" | "noModel" | "configInvalid" | "off";
  items: DecisionView[];            // ordered by seq
  nodes: NodeRefView[];             // nodes that added these items, oldest first
  error: PanelError | null;         // for failed / noModel / configInvalid
}

interface DecisionView {
  id: string;                       // record hash
  seq: number;
  decision: string;
  rationale: string | null;
  quote: string | null;
  author: AuthorView;
  grades: { name: string; grade: number; max: number; low: string | null; high: string | null }[];
  replaces: { id: string; seq: number; decision: string; authorName: string } | null;
}

interface NodeRefView { id: string; shortId: string; branch: string | null }
```

### Examples

**`snapshot`** (one finished exchange, trimmed):

```json
{
  "v": 1, "type": "snapshot",
  "session": { "id": "5d1e9c2a-0000-4000-8000-000000000001", "title": "Sam wants users in Postgres so we're on one database…", "lastActivityAt": "2026-11-27T14:02:11.000Z", "following": "auto", "otherActiveCount": 0 },
  "hasEarlier": false,
  "ledger": { "branch": "main", "detachedAt": null, "extractionEnabled": true },
  "problem": null,
  "exchanges": [{
    "id": "b1c0…",
    "prompt": { "author": { "kind": "human", "name": "Priya" }, "text": "Sam wants users in Postgres…", "at": "2026-11-27T13:58:30.000Z" },
    "response": {
      "model": "claude-opus-5-5", "phase": "ended", "endReason": "done",
      "startedAt": "2026-11-27T13:58:30.000Z", "durationMs": 221000,
      "activity": null, "waiting": null, "errorText": null, "questions": [],
      "files": [{ "path": "prisma/schema.prisma", "kind": "added", "added": 38, "removed": null }],
      "reply": [
        { "type": "text", "markdown": "I'll switch the user store to Postgres…" },
        { "type": "step", "step": { "callId": "toolu_01…", "tool": "Write", "target": "prisma/schema.prisma", "command": null, "description": null, "diffStat": { "added": 38, "removed": null }, "outcome": "ran" } }
      ]
    },
    "decisions": {
      "state": "done",
      "items": [{ "id": "9e1f…", "seq": 15, "decision": "Store users in Postgres instead of MongoDB.", "rationale": "Postgres is already running for billing.", "quote": "store users in Postgres, not Mongo", "author": { "kind": "human", "name": "Priya" }, "grades": [{ "name": "Code span", "grade": 4, "max": 5, "low": "touches a single line or function", "high": "touches the whole codebase" }], "replaces": { "id": "02ab…", "seq": 9, "decision": "Store users in MongoDB.", "authorName": "Sam" } }],
      "nodes": [{ "id": "3f9a2c1e…", "shortId": "3f9a2c1", "branch": "main" }],
      "error": null
    }
  }]
}
```

**`exchangeUpserted`** while Claude Code is probably asking for permission. This is abridged: the real message always carries the whole `ExchangeView`.

```json
{ "v": 1, "type": "exchangeUpserted", "exchange": { "id": "c7d2…", "response": {
  "phase": "working", "activity": "Running npm install prisma…",
  "waiting": { "kind": "permission", "confidence": "possible", "since": "2026-11-27T14:05:02.000Z", "questionId": null,
    "step": { "callId": "toolu_02…", "tool": "Bash", "target": null, "command": "npm install prisma @prisma/client", "description": "Install Prisma", "diffStat": null, "outcome": "pending" } } } } }
```

**`openFile`** with a path that isn't in the exchange:

```json
{ "v": 1, "type": "openFile", "requestId": "r12", "exchangeId": "b1c0…", "path": "../../.ssh/id_rsa" }
{ "v": 1, "type": "actionResult", "requestId": "r12", "ok": false, "error": { "code": "NOT_FOUND", "message": "That file isn't part of this exchange.", "details": null, "actions": [] } }
```

---

## 2. Error format

One shape everywhere in the protocol: decision sections, panel-level problems and action results.

```ts
interface PanelError {
  code: PanelErrorCode;
  message: string;                       // one plain sentence of facts, written by the extension ("The Anthropic API is overloaded (529).")
  details: Record<string, string | number | boolean> | null;   // per code, below
  actions: PanelAction[];                // buttons the webview offers, in order; the first is primary
}
type PanelAction = "retryExtraction" | "setUpModel" | "editParameters" | "enableExtraction" | "rescanSessions" | "chooseSession" | "openOutput";
```

- Errors are converted **in one place**: `panel/errors.ts` (`toPanelError(error)`). Services throw domain errors (engine errors, `ConfigError`, fs errors); problems with no domain error behind them (`NOT_FOUND`, `INVALID_MESSAGE`, `ACTION_FAILED`, `EXTRACTION_OFF`, `NO_SESSION_FOUND`, `LOG_FORMAT_UNRECOGNIZED`) have small builders in the same file, so every `PanelError` the extension sends is made there. The webview builds one itself: `PROTOCOL_VERSION_MISMATCH`, which only it can notice.
- The webview owns titles and icons per code (presentation copy from `docs/ui/chat-panel.md`). The extension owns `message` (facts).
- `message` never contains a key (`ApiError` guarantees this), a model reply (`ModelOutputError.reply` is never forwarded), or a stack.

### Error code catalog

| Code | Scope | When | `details` | `actions` |
|---|---|---|---|---|
| `NO_SESSION_FOUND` | panel | No session file for this workspace | `claudeCodeInstalled: boolean` (extension `anthropic.claude-code` present) | `rescanSessions` |
| `SESSION_UNREADABLE` | panel | The followed file can't be read (permissions, deleted) | `reason` | `rescanSessions`, `chooseSession` |
| `LOG_FORMAT_UNRECOGNIZED` | panel | Format drift: ≥ `FORMAT_DRIFT_MIN_LINES` (50) complete lines and no recognised entry | `lines` | `openOutput` |
| `LEDGER_UNREADABLE` | panel | `.ledger` HEAD or an object can't be read or parsed | `reason` | `openOutput` |
| `EXTRACTION_API_FAILED` | section | `ApiError` | `provider`, `status`, `retryAt` (ISO, if retrying) | 401/403: `setUpModel`, `retryExtraction`; else `retryExtraction` |
| `EXTRACTION_REPLY_UNREADABLE` | section | `ModelOutputError` | `retryAt` | `retryExtraction` |
| `NO_MODEL` | section | `NoModelError` | none | `setUpModel`, `retryExtraction` |
| `LEDGER_CONFIG_INVALID` | section | `ConfigError` (`.ledger/config.json`) | none | `editParameters`, `retryExtraction` |
| `EXTRACTION_FAILED` | section | Any other watcher failure | `retryAt` | `retryExtraction`, `openOutput` |
| `EXTRACTION_OFF` | action | `retryExtraction` while watching is disabled | none | `enableExtraction` |
| `NOT_FOUND` | action | An action names a record, node, file or exchange not in the current model | none | none |
| `ACTION_FAILED` | action | The VS Code command threw | none | `openOutput` |
| `INVALID_MESSAGE` | action | The message failed validation (only if a `requestId` could be read) | `reason` | none |
| `PROTOCOL_VERSION_MISMATCH` | webview-local | Received `v` ≠ the webview's `PROTOCOL_VERSION` | `received`, `expected` | (the webview shows "Reload the panel" and posts `reloadRequest`) |

---

## 3. Internal interfaces

Modules expose these from their `index.ts`. Modules marked **no vscode** must not import `vscode`, so their tests run under `node --test` (they emit events through a small listener type instead of `vscode.Event`).

### claude-log (no vscode)

```ts
type Unsubscribe = { dispose(): void };

interface SessionFile { file: string; sessionId: string; size: number; modifiedAt: number; existedAtStart: boolean }
interface LogBatch { file: string; sessionId: string; fromOffset: number; toOffset: number; entries: LogEntry[] }

interface SessionLogSource {
  /** Polling runs while at least one lease is held (watcher, panel). */
  acquire(): Unsubscribe;
  sessions(): SessionFile[];                                 // newest modifiedAt first
  rescan(): void;                                            // discover now
  cursor(file: string): number;                              // bytes already emitted as appends
  /** Synchronous backfill through the same parser: complete lines in [from, to), to = cursor(file) by default.
   *  Call it, then rely on onDidAppend: no gap, no overlap. */
  read(file: string, from: number, to?: number): LogBatch;
  watchClosely(file: string | undefined): void;              // poll this file every LIVE_POLL_MS (750 ms)
  onDidDiscover(listener: (file: SessionFile) => void): Unsubscribe;
  onDidAppend(listener: (batch: LogBatch) => void): Unsubscribe;
  onDidRemove(listener: (file: string) => void): Unsubscribe;   // a known session file is gone
  driftedLines(file: string): number | undefined;             // set once the file has drifted (for a panel opened after the event)
  onDidFail(listener: (failure: { file: string | null; error: Error }) => void): Unsubscribe;
  onFormatDrift(listener: (drift: { file: string; lines: number }) => void): Unsubscribe;
}

function createSessionLogSource(options: { projectsDir: string; workspace: string; pollMs: number; polling?: "auto" | "manual" }): PollingSessionLogSource;
// PollingSessionLogSource adds tick() (one full poll), tickLive(), isPolling and dispose(); "manual" starts no timers, so tests drive it with tick().
function parseLogLines(lines: string[], startOffset: number): LogEntry[];   // the parser, for tests and backfill
function isTurnEnd(entry: LogEntry): boolean;
```

Cursor rule: a file that existed when the source started begins at its last complete line; a file discovered later begins at 0, so a new session's first prompt is never skipped. Subscribers that need earlier lines (the panel, and the watcher on a chat's first use per D-020) backfill with `read(file, 0, cursor)`.

### watcher

```ts
// watcher/status.ts (no vscode)
interface ExtractionStatus {
  enabled: boolean;
  committedOffset: number;                    // everything before it is in the ledger
  inFlight: { fromOffset: number; toOffset: number } | null;
  failure: { error: unknown; retryAt: number | null } | null;   // the domain error; converted by panel/errors.ts
}
interface ExtractionStatusProvider {
  status(file: string): ExtractionStatus;
  onDidChangeStatus(listener: (file: string) => void): Unsubscribe;
  retryNow(): void;                           // clears backoff and runs a pass immediately
}

// watcher/turns.ts (no vscode)
function toRawTurns(entries: LogEntry[]): RawTurn[];
function appendTurns(turns: RawTurn[], more: RawTurn[]): void;   // unchanged merge rule

// watcher/pipeline.ts (no vscode): all of the watcher's logic, so it can be unit-tested
class ExtractionPipeline implements ExtractionStatusProvider {
  constructor(options: { ledger, source, model: () => Promise<Model>, humanName: () => string, idleMs: () => number,
                         checkEveryMs: number, log, onCommitted, onFailure, onRecovered, now? });
  start(): void; stop(): void; readonly isRunning: boolean;
  useSession(file: string): void;             // the panel follows this chat: process it from its first message (D-020)
  checkNow(): Promise<void>;                  // extract every file that is due
}

// watcher/watcher.ts: the VS Code adapter (settings, getEngine, warnings with fixes)
class AgentWatcher implements ExtractionStatusProvider, vscode.Disposable {
  constructor(ctx, ledger: () => Ledger, source: SessionLogSource, workspace: string, log: vscode.OutputChannel, onChange: () => void);
  start(): void; stop(): void; readonly running: boolean; useSession(file: string): void;
}
```

### core (no vscode)

Unchanged, plus:

```ts
// core/index.ts: the public entry point for new code
export { Ledger, hashObject } from "./store";
export type { Turn, DecisionRecord, LedgerNode, ParameterSet, Author, Grades } from "./records";
export { ingest, ingestBacklog, type RawTurn } from "./…";
export { stripCode, CODE_PLACEHOLDER } from "./code";
export { namedGrades, type NamedGrade } from "./grades";        // moved from render.ts
export { loadParameters, ConfigError } from "./parameters";
export { localHumanName } from "./identity";
export { RetryBackoff } from "./backoff";
export { CLAUDE_CODE_ORIGIN } from "./records";               // the watcher writes it, the panel matches it
// The engine's error classes and grade bounds, so the panel never imports engine (D-018):
export { ApiError, ModelOutputError, NoModelError, GRADE_MIN, GRADE_MAX } from "../../engine/src";
```

### panel

```ts
// pure (no vscode)
class ExchangeBuilder {
  constructor(sessionId: string);
  apply(entries: LogEntry[]): string[];                     // ids of exchanges that changed
  exchanges(): readonly Exchange[];
  exchangeOfEntry(uuid: string): Exchange | undefined;
  readonly orphanResults: number;                           // results with no call in their exchange (drift signal)
}
function phaseOf(ex: Exchange, now: number, quietSince: number): { phase: "working" | "ended"; endReason: EndReason | null };
function hasPendingCall(ex: Exchange): boolean;
function pendingCalls(ex: Exchange): CallState[];            // oldest first
function pendingQuestion(ex: Exchange): CallState | undefined;   // an unanswered AskUserQuestion; phase and waiting share it
function hasPendingQuestion(ex: Exchange): boolean;
function lastTextPart(ex: Exchange): string | undefined;    // the last non-blank text
// constants: PERMISSION_QUIET_MS, TOOLS_THAT_NEVER_ASK, TEXT_QUESTION_PREFIX, THINKING, WRITING_REPLY; type DisplayPath
const STALE_EXCHANGE_MS = 600_000;
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
function detectWaiting(ex: Exchange, now: number, quietSince: number): Waiting | null;
interface Waiting { kind: "question" | "permission"; confidence: "certain" | "likely" | "possible"; since: string; id: string }   // id: tool_use id, or "text:" + exchange id
function collectFileChanges(ex: Exchange): FileChange[];   // absolute paths; view mapping makes them relative
function activityText(ex: Exchange, show?: (absolutePath: string) => string): string;   // the caller shows null once ended

class DecisionLinker {
  constructor(ledger: () => Ledger);
  /** Records on the current branch for this session, grouped by exchange id. Memoised by hash. */
  link(sessionId: string, exchangeOf: (externalId: string) => string | undefined): Map<string, LinkedDecision[]>;
}
interface LinkedDecision { hash: string; record: DecisionRecord; nodeHash: string; grades: NamedGrade[]; replaces: { hash: string; seq: number; decision: string; authorName: string } | null }

function sectionState(input: { exchange: Exchange; phase: Phase; status: ExtractionStatus }): DecisionSectionView["state"];   // whether "notYet" shows (only with decisions so far) is the view's call
interface Derived { phase: Phase; waiting: Waiting | null }              // the clock-dependent values, computed once per render
function deriveExchange(ex: Exchange, now: number, quietSince: number): Derived;
function toDecisionSectionView(input: { state: DecisionSectionState; linked: LinkedDecision[]; branch: string | null; failure: { error: unknown; retryAt: number | null } | null }): DecisionSectionView;
function toExchangeView(input: { exchange: Exchange; derived: Derived; decisions: DecisionSectionView; humanName: string; workspace: string }): ExchangeView;
function displayPath(file: string, workspace: string, platform?: NodeJS.Platform): string;   // relative with "/", else absolute
function closingQuestion(ex: Exchange): string | null;                 // the reply's closing question, shown as a text QuestionView
function toPanelError(error: unknown, context?: { scope?: "section" | "session" | "ledger"; retryAt?: number | null }): PanelError;   // scope picks the code for fs and unknown errors

type FollowChoice = { mode: "auto" } | { mode: "pinned"; sessionId: string };
/** Construct after acquiring the source (the first scan has run). It sets source.watchClosely to the followed file. */
class SessionFollower {
  constructor(source: SessionLogSource, initial: FollowChoice, save: (choice: FollowChoice) => void, now?: () => number);   // a pinned session that's gone → auto, saved
  readonly mode: "auto" | "pinned";
  current(): SessionFile | undefined;
  pin(sessionId: string): boolean;                          // false if the session isn't known
  followLatest(): void;                                     // auto; the session with the newest prompt seen, else the newest file
  onDidChange(listener: (file: SessionFile | undefined) => void): Unsubscribe;   // the file or the mode changed
  dispose(): void;
}
// Auto mode moves on a prompt whose own timestamp is newer than the followed session's last prompt (or than when following began),
// so history replayed from a file found later never moves the panel.

/** The orchestrator: everything the panel does, behind ports, so it is testable without VS Code. */
class SessionPanel {
  constructor(deps: {
    source; follower; status: ExtractionStatusProvider; linker; ledger: () => Ledger; port: WebviewPort; host: HostCommands; clock: Clock;
    workspace: string; humanName: () => string; isExtractionEnabled: () => boolean;
    useSession: (file: string) => void;   // D-020: the followed chat is "used"; also called when watching is turned on
    log: (line: string) => void;
  });
  receive(raw: unknown): void;          // validated with parseWebviewMessage
  ledgerChanged(): void;                // from the .ledger file watcher / watcher onChange / watching toggled
  dispose(): void;
}
// Nothing the panel does throws into the source, the watcher or the webview: failures are logged; those the person can act on become a problem.
interface WebviewPort { post(message: HostMessage): void; setBadge(count: number, tooltip: string): void }
interface Clock { now(): number; setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
const LIVE_UPDATE_MIN_INTERVAL_MS = 250;
interface HostCommands {
  openRecord(hash: string): Promise<void>; revealNode(hash: string): Promise<void>; openFile(absolutePath: string): Promise<void>;
  setUpModel(): Promise<void>; editParameters(): Promise<void>; enableExtraction(): Promise<void>; showOutput(): void;
  pickSession(items: { sessionId: string; label: string; detail: string }[]): Promise<string | undefined>;
  reload(): void;                       // re-render the webview HTML (version mismatch)
  isClaudeCodeInstalled(): boolean;     // for the NO_SESSION_FOUND hint
}

// vscode adapter: the panel starts when the view is first shown, then stays live (for the badge) while hidden
class PanelController implements vscode.WebviewViewProvider, WebviewPort, HostCommands { ledgerChanged(): void; chooseSession(): void; followLatest(): void }
function registerPanel(ctx: vscode.ExtensionContext, deps: { source; watcher: AgentWatcher; ledger: () => Ledger; workspace: string; log: OutputChannel }): PanelController;
```

---

## 4. Webview HTML and security (`panel/html.ts`)

- `webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [out/browser] }`. `retainContextWhenHidden` is off: a re-shown view sends `ready` and gets a fresh snapshot.
- CSP (one `<meta>`, a fresh nonce per render):
  `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};`
  `${cspSource}` is in `script-src` only so that the entry module can import its sibling modules. No `unsafe-inline`, no `unsafe-eval`, no remote origins.
- Log text is rendered with DOM APIs and `textContent` only. Markdown links render as anchors only for `http:`/`https:` hrefs; everything else renders as text.

---

## 5. Reserved for "save a missed sentence as a decision" (not built in v1)

- **Engine (proposed contract addition, owned by the engine developer):**
  ```ts
  interface GradingInput { decision: string; turn: EngineTurn; parameters: ParameterDefinition[] }
  function gradeDecision(input: GradingInput, model: Model): Promise<Grades>;   // same grade guarantees as extraction (#3)
  ```
  It's additive, so the existing `extractDecisions` contract is unchanged.
- **core:** `saveDecision(ledger, { turn, quote, decision, savedBy }, model)` stores the turn (code stripped), grades it with `gradeDecision`, and commits one record in its own node with `origin: "manual"` and message `Saved by {savedBy} from the full reply`. The record shape is unchanged: `author` is whoever wrote the sentence and `source` is `{ turn, quote }`. If the selected quote is only code, the save is refused.
- **protocol:** `saveDecision { exchangeId, partIndex, quote }`, answered by `actionResult` and then `exchangeUpserted`.
