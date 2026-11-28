/**
 * The extraction pipeline, free of vscode so it can be tested: new log entries become
 * pending turns per session file, and pending turns become ledger records when a reply
 * ends (D-011), when the file goes quiet, or when the backlog is large. A chat is
 * processed from its first message the first time it's used (D-020).
 */
import { ApiError, type Model } from "../../engine/src";
import { chunkTurns, CLAUDE_CODE_ORIGIN, ingestBacklog, RetryBackoff, type Ledger, type RawTurn } from "../core";
import { isTurnEnd, Listeners, sessionIdOf, type LogBatch, type SessionLogSource, type SourceFailure, type Unsubscribe } from "../claude-log";
import { appendTurns, toRawTurns } from "./turns";
import { readWatchState, writeWatchState, type WatchState } from "./offsets";
import type { ExtractionStatus, ExtractionStatusProvider } from "./status";

export const MAX_TURNS_PER_BATCH = 24;
export const MAX_CHARS_PER_TURN = 4000;
const SHORT_ID_CHARS = 8;
const SHORT_HASH_CHARS = 7;
const DISCOVERY_SOURCE = "scan";

export interface PipelineOptions {
  ledger: () => Ledger;
  source: SessionLogSource;
  model: () => Promise<Model>;
  humanName: () => string;
  /** How long a file must be quiet before its turns are extracted mid-reply. */
  idleMs: () => number;
  /** How often quiet files are checked; 0 = never on a timer (tests call checkNow). */
  checkEveryMs: number;
  log: (line: string) => void;
  /** New records are in the ledger. */
  onCommitted: () => void;
  /** A new, distinct failure; repeats are not reported. */
  onFailure: (error: unknown) => void;
  /** A file that was failing succeeded again. */
  onRecovered: () => void;
  now?: () => number;
}

/** Turns read from one session file but not yet committed to the ledger. */
interface Pending {
  turns: RawTurn[];
  /** Everything before it has been read into `turns` or committed. */
  offset: number;
  lastGrowth: number;
  /** A reply ended, or earlier history was read in: don't wait for the file to go quiet. */
  flushSoon: boolean;
  /** First use of this chat: skip turns the ledger already has (a resumed session repeats its history, A13). */
  skipKnownTurns: boolean;
}

export class ExtractionPipeline implements ExtractionStatusProvider {
  private running = false;
  private watch: WatchState = {};
  private readonly pending = new Map<string, Pending>();
  /** Per session file, so one failing file doesn't slow the healthy ones. */
  private readonly backoffs = new Map<string, RetryBackoff>();
  private readonly failures = new Map<string, { error: unknown; retryAt: number | null }>();
  private readonly inFlight = new Map<string, { fromOffset: number; toOffset: number }>();
  private readonly statusChanged = new Listeners<string>();
  private readonly reportedSourceFailures = new Map<string, string>();
  private subscriptions: Unsubscribe[] = [];
  private timer: NodeJS.Timeout | undefined;
  private isFlushing = false;
  /** Bumped by stop(), so a flush that outlives its run doesn't report failures to the next one. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: PipelineOptions) {
    this.now = options.now ?? Date.now;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.watch = readWatchState(this.options.ledger());
    const { source } = this.options;
    // Subscribe before acquiring: the first scan reports files as it finds them.
    this.subscriptions = [
      source.onDidAppend((batch) => this.onAppend(batch)),
      source.onDidDiscover((found) => this.catchUp(found.file)),
      source.onDidFail((failure) => this.onSourceFailure(failure)),
      source.onFormatDrift(({ file, lines }) => this.options.log(`claude-code ${shortId(file)}: ${lines} lines, none recognised; Claude Code's log format may have changed`)),
      source.acquire(),
    ];
    for (const session of source.sessions()) this.catchUp(session.file);
    if (this.options.checkEveryMs > 0) this.timer = setInterval(() => void this.checkNow(), this.options.checkEveryMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
    for (const file of Object.keys(this.watch)) this.notify(file);
  }

  /** The panel follows this chat: process it from its first message (D-020). */
  useSession(file: string): void {
    if (!this.running) return;
    this.ensureTracked(file);
    this.catchUp(file);
  }

  status(file: string): ExtractionStatus {
    return {
      enabled: this.running,
      committedOffset: this.committed(file),
      inFlight: this.inFlight.get(file) ?? null,
      failure: this.failures.get(file) ?? null,
    };
  }

  onDidChangeStatus(listener: (file: string) => void): Unsubscribe {
    return this.statusChanged.add(listener);
  }

  retryNow(): void {
    const failed = [...this.failures.keys()];
    this.failures.clear();
    this.backoffs.clear();
    for (const file of failed) {
      const backlog = this.pending.get(file);
      if (backlog) backlog.flushSoon = true;
      this.notify(file);
    }
    void this.checkNow();
  }

  /** Extracts every file that is due, one at a time. */
  async checkNow(): Promise<void> {
    if (this.isFlushing || !this.running) return;
    this.isFlushing = true;
    try {
      for (let file = this.nextDue(); file !== undefined && this.running; file = this.nextDue()) {
        await this.flush(file, this.pending.get(file)!);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private onAppend(batch: LogBatch): void {
    if (!this.running) return;
    this.reportedSourceFailures.delete(batch.file);
    const backlog = this.pending.get(batch.file) ?? this.startPending(batch.file, batch.fromOffset);
    const fresh = batch.entries.filter((e) => e.startOffset >= backlog.offset);
    this.addTurns(backlog, toRawTurns(fresh));
    backlog.offset = Math.max(backlog.offset, batch.toOffset);
    backlog.lastGrowth = this.now();
    if (fresh.some(isTurnEnd)) backlog.flushSoon = true;
    if (backlog.flushSoon) void this.checkNow();
  }

  /**
   * A tracked file that grew while the extension wasn't running: read what was missed.
   * A read failure is reported and leaves no backlog, so the next append reads again.
   */
  private catchUp(file: string): void {
    if (!this.running || this.pending.has(file) || !this.watch[file]) return;
    const cursor = this.options.source.cursor(file);
    if (this.watch[file].offset >= cursor) return;
    try {
      this.startPending(file, cursor);
    } catch (error) {
      this.recordFailure(file, error);
      return;
    }
    void this.checkNow();
  }

  /** Starts a file's backlog with everything from its committed offset up to `readTo`. */
  private startPending(file: string, readTo: number): Pending {
    const isFirstUse = this.ensureTracked(file);
    const from = this.watch[file].offset;
    const earlier = from < readTo ? this.options.source.read(file, from, readTo) : undefined;
    const backlog: Pending = {
      turns: [],
      offset: earlier?.toOffset ?? from,
      lastGrowth: this.now(),
      flushSoon: !!earlier && earlier.toOffset > from,
      skipKnownTurns: isFirstUse,
    };
    this.addTurns(backlog, toRawTurns(earlier?.entries ?? []));
    this.pending.set(file, backlog);
    return backlog;
  }

  /** D-020: a chat seen for the first time is processed from its first message. Returns whether it was new. */
  private ensureTracked(file: string): boolean {
    if (this.watch[file]) return false;
    this.watch[file] = { offset: 0 };
    writeWatchState(this.options.ledger(), this.watch);
    return true;
  }

  /** Filtering happens here, before chunking, so a long turn split across batches is never cut short on a retry. */
  private addTurns(backlog: Pending, turns: RawTurn[]): void {
    if (backlog.skipKnownTurns && turns.length) {
      const grounded = this.groundedLogLines();
      turns = turns.filter((t) => !(t.externalId && grounded.has(t.externalId)));
    }
    appendTurns(backlog.turns, turns);
  }

  private nextDue(): string | undefined {
    for (const [file, backlog] of this.pending) if (this.isDue(file, backlog)) return file;
    return undefined;
  }

  private isDue(file: string, backlog: Pending): boolean {
    if (backlog.offset <= this.committed(file) || !this.backoffFor(file).canTry(this.now())) return false;
    return backlog.flushSoon || this.now() - backlog.lastGrowth >= this.options.idleMs() || backlog.turns.length >= MAX_TURNS_PER_BATCH;
  }

  /**
   * Commits the backlog batch by batch, saving the safe offset after each one, so a
   * failure or reload part-way neither loses nor repeats turns (except inside a single
   * turn longer than a batch; see core/batches). Turns read meanwhile wait for the next flush.
   */
  private async flush(file: string, backlog: Pending): Promise<void> {
    const generation = this.generation;
    const target = backlog.offset;
    const turns = chunkTurns(this.afterCommitted(file, backlog.turns), MAX_CHARS_PER_TURN);
    backlog.turns = [];
    backlog.flushSoon = false;
    this.inFlight.set(file, { fromOffset: this.committed(file), toOffset: target });
    this.notify(file);
    try {
      if (turns.length) await this.ingest(file, turns);
      this.commit(file, target);
      this.recovered(file);
      backlog.skipKnownTurns = false;
    } catch (error) {
      backlog.turns = [...turns, ...backlog.turns]; // ingestBacklog removed the committed ones
      if (generation === this.generation) this.recordFailure(file, error);
    } finally {
      this.inFlight.delete(file);
      this.notify(file);
    }
  }

  private async ingest(file: string, turns: RawTurn[]): Promise<void> {
    const session = turns.find((t) => t.session)?.session || sessionIdOf(file);
    const model = await this.options.model();
    const meta = { origin: CLAUDE_CODE_ORIGIN, session, humanName: this.options.humanName() };
    await ingestBacklog(this.options.ledger(), turns, model, meta, MAX_TURNS_PER_BATCH, (batch) => {
      const outcome = batch.result ? `${batch.result.records.length} decisions, node ${batch.result.node.slice(0, SHORT_HASH_CHARS)}` : "no decisions";
      this.options.log(`claude-code ${session.slice(0, SHORT_ID_CHARS)}: ${batch.turns} turns → ${outcome}`);
      // Progress is saved before anyone is told, so a listener that throws can't make these turns be extracted again.
      if (batch.safeOffset !== undefined) this.commit(file, batch.safeOffset);
      if (batch.result) this.tellCommitted();
    });
  }

  private tellCommitted(): void {
    try {
      this.options.onCommitted();
    } catch (error) {
      this.options.log(`a listener failed after a commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Drops turns before the committed offset: a flush from before a stop/start may have
   * committed them meanwhile. A safe offset never falls inside a source turn.
   */
  private afterCommitted(file: string, turns: RawTurn[]): RawTurn[] {
    const committed = this.committed(file);
    return turns.filter((t) => t.endOffset === undefined || t.endOffset > committed);
  }

  /** Log lines (uuids) that already ground a decision from Claude Code on this branch. */
  private groundedLogLines(): Set<string> {
    const ledger = this.options.ledger();
    const ids = new Set<string>();
    for (const { record } of ledger.stateAt()) {
      const turn = ledger.turn(record.source.turn);
      if (turn.origin === CLAUDE_CODE_ORIGIN && turn.externalId) ids.add(turn.externalId);
    }
    return ids;
  }

  private commit(file: string, offset: number): void {
    this.watch[file] = { offset };
    writeWatchState(this.options.ledger(), this.watch);
    this.notify(file);
  }

  private committed(file: string): number {
    return this.watch[file]?.offset ?? 0;
  }

  private backoffFor(file: string): RetryBackoff {
    let backoff = this.backoffs.get(file);
    if (!backoff) this.backoffs.set(file, (backoff = new RetryBackoff()));
    return backoff;
  }

  /** Logs each distinct failure once per file; repeats only push that file's next retry further out. */
  private recordFailure(file: string, error: unknown): void {
    const backoff = this.backoffFor(file);
    const isNew = backoff.fail(failureKey(error), this.now());
    this.failures.set(file, { error, retryAt: backoff.nextTryAt });
    if (!isNew) return;
    this.options.log(`watcher error (${shortId(file)}): ${messageOf(error)} (retrying with backoff; repeats are not logged)`);
    this.options.onFailure(error);
  }

  private recovered(file: string): void {
    this.backoffFor(file).reset();
    if (this.failures.delete(file)) this.options.onRecovered();
  }

  private onSourceFailure({ file, error }: SourceFailure): void {
    const where = file ?? DISCOVERY_SOURCE;
    if (this.reportedSourceFailures.get(where) === error.message) return;
    this.reportedSourceFailures.set(where, error.message);
    this.options.log(`watcher error (${file ? shortId(file) : DISCOVERY_SOURCE}): ${error.message}`);
  }

  private notify(file: string): void {
    try {
      this.statusChanged.emit(file);
    } catch (error) {
      this.options.log(`extraction status listener failed: ${messageOf(error)}`);
    }
  }
}

/** Stable identity for an error: API failures differ per request (ids in the body), so key them by provider and status. */
export function failureKey(error: unknown): string {
  if (error instanceof ApiError) return `${error.provider} API ${error.status}`;
  return messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(file: string): string {
  return sessionIdOf(file).slice(0, SHORT_ID_CHARS);
}
