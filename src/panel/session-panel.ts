/**
 * The panel's orchestrator: everything the panel does, behind two ports (WebviewPort,
 * HostCommands) and a clock, so it is tested without VS Code (modules.md). It follows one
 * session, keeps its exchanges current, sends updates through the UpdateScheduler, and
 * keeps the badge. Nothing it does throws back into the source, the watcher or the
 * webview: failures are logged, and those the person can act on become a problem.
 */
import type { Ledger } from "../core";
import type { LogBatch, SessionLogSource, SourceFailure, Unsubscribe } from "../claude-log";
import { MAX_SNAPSHOT_EXCHANGES, parseWebviewMessage, PROTOCOL_VERSION, type ExchangeView, type HostMessage, type LedgerView, type PanelError } from "../protocol";
import type { ExtractionStatusProvider } from "../watcher";
import { runAction, type ActionContext, type ActionMessage, type HostCommands } from "./actions";
import { actionFailed, formatUnrecognized, invalidMessage, noSessionFound, toPanelError } from "./errors";
import { FollowedSession } from "./followed-session";
import type { SessionFollower } from "./follower";
import type { DecisionLinker, LinkedDecision } from "./linker";
import { badgeOf, derivedOf, exchangeViewOf, ledgerViewOf, sessionViewOf, type PanelState } from "./panel-views";
import { STALE_EXCHANGE_MS } from "./phase";
import { UpdateScheduler, type Clock } from "./update-scheduler";
import { PERMISSION_QUIET_MS } from "./waiting";

export { LIVE_UPDATE_MIN_INTERVAL_MS, type Clock } from "./update-scheduler";

export interface WebviewPort {
  post(message: HostMessage): void;
  setBadge(count: number, tooltip: string): void;
}

export interface SessionPanelDeps {
  source: SessionLogSource;
  follower: SessionFollower;
  status: ExtractionStatusProvider;
  linker: DecisionLinker;
  ledger: () => Ledger;
  port: WebviewPort;
  host: HostCommands;
  clock: Clock;
  workspace: string;
  humanName: () => string;
  isExtractionEnabled: () => boolean;
  /** The panel follows this session: the watcher processes it from its first message (D-020). */
  useSession: (file: string) => void;
  log: (line: string) => void;
}

const NO_LEDGER: LedgerView = { branch: null, detachedAt: null, extractionEnabled: false };

export class SessionPanel {
  private session: FollowedSession | undefined;
  private linked = new Map<string, LinkedDecision[]>();
  /** Read with the links, inside the ledger guard, so rendering never reads the disk. */
  private ledgerView: LedgerView = NO_LEDGER;
  /** A panel-level problem (unreadable log, format drift, unreadable ledger); shown instead of the exchanges. */
  private problem: PanelError | null = null;
  private isReady = false;
  /** What the webview has: each exchange's decision section, and the ledger line. */
  private readonly sentSections = new Map<string, string>();
  private sentLedger = "";
  private sentBadge = "";
  private readonly scheduler: UpdateScheduler;
  private readonly subscriptions: Unsubscribe[];

  constructor(private readonly deps: SessionPanelDeps) {
    this.scheduler = new UpdateScheduler(deps.clock, (ids) => this.sendUpserts(ids));
    this.subscriptions = [
      deps.follower.onDidChange(() => this.safely("follow", () => this.follow())),
      deps.source.onDidAppend((batch) => this.safely("append", () => this.onAppend(batch))),
      deps.source.onDidFail((failure) => this.safely("source failure", () => this.onFail(failure))),
      deps.source.onFormatDrift(({ file, lines }) => this.safely("format drift", () => this.onDrift(file, lines))),
      deps.status.onDidChangeStatus((file) => file === this.session?.file.file && this.ledgerChanged()),
    ];
    this.safely("start", () => this.follow());
  }

  /** A message from the webview, validated here. */
  receive(raw: unknown): void {
    this.safely("message", () => {
      const parsed = parseWebviewMessage(raw);
      if (!parsed.ok) {
        this.deps.log(`panel: dropped a message (${parsed.receivedType ?? "no type"}): ${parsed.reason}`);
        if (parsed.requestId) this.post({ v: PROTOCOL_VERSION, type: "actionResult", requestId: parsed.requestId, ok: false, error: invalidMessage(parsed.reason) });
        return;
      }
      const message = parsed.message;
      if (message.type === "ready") return this.onReady();
      if (message.type === "protocolError") return this.deps.log(`panel webview: ${message.reason} (${message.receivedType ?? "no type"})`);
      if (message.type === "reloadRequest") return this.deps.host.reload();
      void this.act(message);
    });
  }

  /** The ledger, watching, or the watcher's status changed: relink, then update what changed. */
  ledgerChanged(): void {
    this.safely("ledger change", () => {
      if (!this.session) return;
      // Watching may have just been turned on: the followed chat is used (D-020). Repeating this is harmless.
      if (this.deps.isExtractionEnabled()) this.useSession(this.session.file.file);
      if (!this.relink() || JSON.stringify(this.ledgerView) !== this.sentLedger) return this.snapshot();
      const state = this.state();
      const changed = this.session.exchanges().filter((e) => this.sentSections.has(e.id) && this.sectionKey(state, e.id) !== this.sentSections.get(e.id));
      this.scheduler.queue(changed.map((e) => e.id));
      this.updateBadge();
    });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.scheduler.dispose();
  }

  // ---------- following ----------

  /** (Re)reads the followed session from its start (D-017) and tells the watcher it is used (D-020). */
  private follow(): void {
    const file = this.deps.follower.current();
    this.problem = null;
    this.session = undefined;
    if (file) {
      try {
        this.session = new FollowedSession(file, this.deps.source);
      } catch (error) {
        this.fail("session", error);
      }
    }
    this.relink();
    if (this.session) {
      this.useSession(this.session.file.file);
      const drifted = this.deps.source.driftedLines(this.session.file.file);
      if (drifted !== undefined) this.problem = formatUnrecognized(drifted);
    }
    this.snapshot();
    this.scheduleWake();
    this.updateBadge();
  }

  private onReady(): void {
    this.isReady = true;
    this.follow();
  }

  private onAppend(batch: LogBatch): void {
    if (batch.file !== this.deps.follower.current()?.file) return;
    // The first read failed, or the log was unreadable: it is readable again.
    if (!this.session || this.problem?.code === "SESSION_UNREADABLE") return this.follow();
    this.scheduler.queue(this.session.apply(batch, this.deps.clock.now()));
    this.scheduleWake();
    this.updateBadge();
  }

  private onFail({ file, error }: SourceFailure): void {
    if (file === null || file !== this.deps.follower.current()?.file) return;
    this.fail("session", error);
    this.snapshot();
    this.updateBadge();
  }

  private onDrift(file: string, lines: number): void {
    if (file !== this.session?.file.file) return;
    this.problem = formatUnrecognized(lines);
    this.snapshot();
    this.updateBadge();
  }

  /** Re-reads the ledger line and the links. False if the ledger couldn't be read (the problem is set). */
  private relink(): boolean {
    const session = this.session;
    try {
      this.ledgerView = ledgerViewOf(this.deps.ledger(), this.deps.isExtractionEnabled());
      this.linked = session ? this.deps.linker.link(session.file.sessionId, (uuid) => session.builder.exchangeOfEntry(uuid)?.id) : new Map();
      if (this.problem?.code === "LEDGER_UNREADABLE") this.problem = null;
      return true;
    } catch (error) {
      this.fail("ledger", error);
      return false;
    }
  }

  /** Marking a chat used writes the watcher's state; if that fails, the panel still works. */
  private useSession(file: string): void {
    this.safely("use session", () => this.deps.useSession(file));
  }

  private fail(scope: "session" | "ledger", error: unknown): void {
    this.deps.log(`panel: ${scope} problem: ${error instanceof Error ? error.message : String(error)}`);
    this.problem = toPanelError(error, { scope });
  }

  /** Every entry point runs through here: a failure is logged, never thrown into the source, watcher or webview. */
  private safely(what: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.deps.log(`panel: ${what} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }

  // ---------- sending ----------

  private snapshot(): void {
    this.scheduler.discard();
    this.sentSections.clear();
    if (!this.isReady) return;
    this.sentLedger = JSON.stringify(this.ledgerView);
    const base = { v: PROTOCOL_VERSION, type: "snapshot" as const, ledger: this.ledgerView, hasEarlier: false };
    const file = this.deps.follower.current();
    if (!this.session || !file) {
      return this.post({ ...base, session: null, exchanges: [], problem: this.problem ?? noSessionFound(this.deps.host.isClaudeCodeInstalled()) });
    }
    const all = this.problem ? [] : this.session.exchanges();
    const shown = all.slice(-MAX_SNAPSHOT_EXCHANGES);
    const state = this.state();
    const session = sessionViewOf(this.session, file, this.deps.follower.mode, this.deps.source.sessions(), state.now);
    this.post({ ...base, session, exchanges: shown.map((e) => this.viewFor(state, e.id)), hasEarlier: all.length > shown.length, problem: this.problem });
  }

  private sendUpserts(ids: string[]): void {
    if (!this.isReady || !this.session || this.problem) return;
    const state = this.state();
    for (const id of ids) if (this.session.exchange(id)) this.post({ v: PROTOCOL_VERSION, type: "exchangeUpserted", exchange: this.viewFor(state, id) });
  }

  /**
   * Quiet changes what an exchange means without a new line: after PERMISSION_QUIET_MS a
   * pending call may be waiting, after STALE_EXCHANGE_MS the reply is incomplete. Wakes up
   * at the next of those moments for the newest exchange.
   */
  private scheduleWake(): void {
    const latest = this.session?.latest();
    const now = this.deps.clock.now();
    const isWorking = !!this.session && !!latest && derivedOf(this.state(), latest).phase.phase === "working";
    const next = isWorking ? [PERMISSION_QUIET_MS, STALE_EXCHANGE_MS].map((ms) => this.session!.quietSince + ms).find((at) => at > now) : undefined;
    this.scheduler.wakeAt(next, () =>
      this.safely("wake", () => {
        this.scheduler.queue([latest!.id]);
        this.scheduler.flush();
        this.updateBadge();
        this.scheduleWake();
      })
    );
  }

  private updateBadge(): void {
    const badge = this.session && !this.problem ? badgeOf(this.state()) : { count: 0, tooltip: "" };
    const key = `${badge.count}|${badge.tooltip}`;
    if (key === this.sentBadge) return;
    this.sentBadge = key;
    this.deps.port.setBadge(badge.count, badge.tooltip);
  }

  private async act(message: ActionMessage): Promise<void> {
    let error: PanelError | null;
    try {
      error = await runAction(message, this.actionContext());
    } catch (thrown) {
      this.deps.log(`panel: ${message.type} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      error = actionFailed();
    }
    this.post({ v: PROTOCOL_VERSION, type: "actionResult", requestId: message.requestId, ok: error === null, error });
  }

  private actionContext(): ActionContext {
    const { deps } = this;
    return {
      host: deps.host,
      follower: deps.follower,
      workspace: deps.workspace,
      session: () => this.session,
      linked: () => this.linked,
      sessions: () => deps.source.sessions(),
      isExtractionEnabled: deps.isExtractionEnabled,
      retryExtraction: () => deps.status.retryNow(),
      rescan: () => {
        deps.source.rescan();
        if (!this.session || this.problem?.code === "SESSION_UNREADABLE") this.follow();
      },
      sendEarlier: (before) => this.sendEarlier(before),
      now: () => deps.clock.now(),
    };
  }

  private sendEarlier(beforeExchangeId: string): boolean {
    const all = this.session?.exchanges() ?? [];
    const index = all.findIndex((e) => e.id === beforeExchangeId);
    if (index < 0) return false;
    const from = Math.max(0, index - MAX_SNAPSHOT_EXCHANGES);
    const state = this.state();
    this.post({ v: PROTOCOL_VERSION, type: "exchangesPrepended", exchanges: all.slice(from, index).map((e) => this.viewFor(state, e.id)), hasEarlier: from > 0 });
    return true;
  }

  // ---------- state ----------

  /** Only call with a session. Reads no files: the branch comes from the last relink. */
  private state(): PanelState {
    const { deps } = this;
    return {
      session: this.session!,
      linked: this.linked,
      status: deps.status.status(this.session!.file.file),
      branch: this.ledgerView.branch,
      now: deps.clock.now(),
      humanName: deps.humanName(),
      workspace: deps.workspace,
    };
  }

  /** The view, remembering its decision section so ledgerChanged sends only what changed. */
  private viewFor(state: PanelState, id: string): ExchangeView {
    const view = exchangeViewOf(state, this.session!.exchange(id)!);
    this.sentSections.set(id, JSON.stringify(view.decisions));
    return view;
  }

  private sectionKey(state: PanelState, id: string): string {
    return JSON.stringify(exchangeViewOf(state, this.session!.exchange(id)!).decisions);
  }

  private post(message: HostMessage): void {
    this.deps.port.post(message);
  }
}
