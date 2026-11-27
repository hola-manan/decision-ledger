/**
 * The one reader of Claude Code session logs (D-003). It keeps one byte cursor per file,
 * reads complete lines only, parses each line once and hands the entries to every
 * subscriber (the watcher, the panel). Polling, not fs.watch: file events are unreliable
 * on Windows and in synced folders (D-005).
 */
import * as fs from "fs";
import type { LogEntry } from "./entries";
import { findSessionFiles, sessionIdOf } from "./discover";
import { Listeners, Unsubscribe } from "./listeners";
import { parseLogLines } from "./parse";

/** How often the followed file is checked (D-005). */
export const LIVE_POLL_MS = 750;
/** Format drift: this many complete lines in a file with no recognised entry. */
export const DRIFT_MIN_LINES = 50;
const NEWLINE = 0x0a;
const TAIL_BLOCK_BYTES = 64 * 1024;

export interface SessionFile {
  file: string;
  sessionId: string;
  size: number;
  modifiedAt: number;
  existedAtStart: boolean;
}

export interface LogBatch {
  file: string;
  sessionId: string;
  fromOffset: number;
  toOffset: number;
  entries: LogEntry[];
}

export interface SessionLogSource {
  /** Polling runs while at least one lease is held. */
  acquire(): Unsubscribe;
  /** Newest modifiedAt first. */
  sessions(): SessionFile[];
  /** Discover now. */
  rescan(): void;
  /** Bytes already emitted as appends. */
  cursor(file: string): number;
  /**
   * Backfill through the same parser: complete lines in [from, to), `to` = cursor(file) by
   * default. Call it, then rely on onDidAppend: no gap, no overlap.
   */
  read(file: string, from: number, to?: number): LogBatch;
  /** Poll this file every LIVE_POLL_MS; undefined stops. */
  watchClosely(file: string | undefined): void;
  onDidDiscover(listener: (file: SessionFile) => void): Unsubscribe;
  onDidAppend(listener: (batch: LogBatch) => void): Unsubscribe;
  onDidFail(listener: (failure: SourceFailure) => void): Unsubscribe;
  onFormatDrift(listener: (drift: { file: string; lines: number }) => void): Unsubscribe;
}

/** `file` is null when discovery itself failed. */
export interface SourceFailure {
  file: string | null;
  error: Error;
}

export interface SessionLogSourceOptions {
  projectsDir: string;
  workspace: string;
  pollMs: number;
  /** "manual": no timers; tests drive it with tick(). */
  polling?: "auto" | "manual";
}

interface TrackedFile extends SessionFile {
  cursor: number;
  lineCount: number;
  entryCount: number;
  driftReported: boolean;
}

export function createSessionLogSource(options: SessionLogSourceOptions): PollingSessionLogSource {
  return new PollingSessionLogSource(options);
}

export class PollingSessionLogSource implements SessionLogSource {
  private readonly files = new Map<string, TrackedFile>();
  private readonly cwdMemo = new Map<string, boolean>();
  private readonly discovered = new Listeners<SessionFile>();
  private readonly appended = new Listeners<LogBatch>();
  private readonly failed = new Listeners<SourceFailure>();
  private readonly drifted = new Listeners<{ file: string; lines: number }>();
  private leases = 0;
  private hasScanned = false;
  private closelyWatched: string | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly options: SessionLogSourceOptions) {}

  acquire(): Unsubscribe {
    if (++this.leases === 1) this.startPolling();
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        if (--this.leases === 0) this.stopPolling();
      },
    };
  }

  get isPolling(): boolean {
    return this.leases > 0;
  }

  sessions(): SessionFile[] {
    return [...this.files.values()].map(toSessionFile).sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  cursor(file: string): number {
    return this.files.get(file)?.cursor ?? 0;
  }

  read(file: string, from: number, to?: number): LogBatch {
    const tracked = this.files.get(file);
    if (!tracked) throw new Error(`Not a known session file: ${file}`);
    return this.readLines(tracked, from, to ?? tracked.cursor).batch;
  }

  watchClosely(file: string | undefined): void {
    this.closelyWatched = file;
  }

  onDidDiscover(listener: (file: SessionFile) => void): Unsubscribe {
    return this.discovered.add(listener);
  }

  onDidAppend(listener: (batch: LogBatch) => void): Unsubscribe {
    return this.appended.add(listener);
  }

  onDidFail(listener: (failure: SourceFailure) => void): Unsubscribe {
    return this.failed.add(listener);
  }

  onFormatDrift(listener: (drift: { file: string; lines: number }) => void): Unsubscribe {
    return this.drifted.add(listener);
  }

  /** One full poll: discover, then read every file that grew. */
  tick(): void {
    this.rescan();
    for (const tracked of this.files.values()) this.poll(tracked);
  }

  /** Reads the followed file if it grew. */
  tickLive(): void {
    const tracked = this.closelyWatched && this.files.get(this.closelyWatched);
    if (tracked) this.poll(tracked);
  }

  /**
   * Files found on the first scan existed before the source started: their cursor starts
   * at their last complete line. Files found later start at 0, so a new session's first
   * prompt is never missed.
   */
  rescan(): void {
    let found: string[];
    try {
      found = findSessionFiles(this.options.projectsDir, this.options.workspace, this.cwdMemo);
    } catch (error) {
      this.failed.emit({ file: null, error: asError(error) });
      return;
    }
    const existedAtStart = !this.hasScanned;
    this.hasScanned = true;
    const present = new Set(found);
    for (const file of this.files.keys()) if (!present.has(file)) this.files.delete(file);
    for (const file of found) if (!this.files.has(file)) this.track(file, existedAtStart);
  }

  dispose(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    this.tick();
    if (this.options.polling === "manual") return;
    this.timers = [setInterval(() => this.tick(), this.options.pollMs), setInterval(() => this.tickLive(), LIVE_POLL_MS)];
  }

  private stopPolling(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private track(file: string, existedAtStart: boolean): void {
    this.guarded(file, () => {
      const stat = fs.statSync(file);
      const tracked: TrackedFile = {
        file,
        sessionId: sessionIdOf(file),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        existedAtStart,
        cursor: existedAtStart ? lastCompleteLineEnd(file, stat.size) : 0,
        lineCount: 0,
        entryCount: 0,
        driftReported: false,
      };
      this.files.set(file, tracked);
      this.discovered.emit(toSessionFile(tracked));
    });
  }

  private poll(tracked: TrackedFile): void {
    this.guarded(tracked.file, () => {
      const stat = fs.statSync(tracked.file);
      tracked.size = stat.size;
      tracked.modifiedAt = stat.mtimeMs;
      if (stat.size < tracked.cursor) {
        const was = tracked.cursor;
        tracked.cursor = 0;
        throw new Error(`Session log got shorter (${stat.size} < ${was} bytes); reading it again from the start`);
      }
      if (stat.size === tracked.cursor) return;
      const { batch, lineCount } = this.readLines(tracked, tracked.cursor, stat.size);
      if (batch.toOffset === tracked.cursor) return; // only a half-written line so far
      tracked.cursor = batch.toOffset;
      this.noteDrift(tracked, lineCount, batch.entries.length);
      this.appended.emit(batch);
    });
  }

  /** Complete lines only (A2): a half-written last line waits for the next read. */
  private readLines(tracked: TrackedFile, from: number, to: number): { batch: LogBatch; lineCount: number } {
    const empty = { file: tracked.file, sessionId: tracked.sessionId, fromOffset: from, toOffset: from, entries: [] };
    if (to <= from) return { batch: empty, lineCount: 0 };
    const bytes = readBytes(tracked.file, from, to - from);
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    if (end === 0) return { batch: empty, lineCount: 0 };
    const lines = bytes.subarray(0, end - 1).toString("utf8").split("\n");
    return { batch: { ...empty, toOffset: from + end, entries: parseLogLines(lines, from) }, lineCount: lines.length };
  }

  private noteDrift(tracked: TrackedFile, lines: number, entries: number): void {
    tracked.lineCount += lines;
    tracked.entryCount += entries;
    if (tracked.driftReported || tracked.entryCount > 0 || tracked.lineCount < DRIFT_MIN_LINES) return;
    tracked.driftReported = true;
    this.drifted.emit({ file: tracked.file, lines: tracked.lineCount });
  }

  /** A failure (including a throwing subscriber) is reported for its file; other files keep flowing. */
  private guarded(file: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.failed.emit({ file, error: asError(error) });
    }
  }
}

function toSessionFile({ file, sessionId, size, modifiedAt, existedAtStart }: TrackedFile): SessionFile {
  return { file, sessionId, size, modifiedAt, existedAtStart };
}

function readBytes(file: string, position: number, length: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
  } finally {
    fs.closeSync(fd);
  }
}

/** The offset just past the last newline before `size`, scanning back from the end. */
function lastCompleteLineEnd(file: string, size: number): number {
  for (let end = size; end > 0; end -= TAIL_BLOCK_BYTES) {
    const start = Math.max(0, end - TAIL_BLOCK_BYTES);
    const newline = readBytes(file, start, end - start).lastIndexOf(NEWLINE);
    if (newline >= 0) return start + newline + 1;
  }
  return 0;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
