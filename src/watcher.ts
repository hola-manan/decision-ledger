/**
 * Output 3 — autonomous agents. Tails Claude Code session logs for this workspace and
 * replaces the long trail with ordered decision records.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Ledger } from "./core/store";
import { appendTurns, findSessionFiles, parseClaudeCodeLines, RawTurn } from "./core/transcript";
import { chunkTurns } from "./core/chunk";
import { ingestBacklog } from "./core/batches";
import { RetryBackoff } from "./core/backoff";
import { ApiError, NoModelError } from "../engine/src";
import { getEngine } from "./provider";

interface FileState {
  offset: number;
}
type WatchState = Record<string, FileState>;

/** Turns read from one session file but not yet committed to the ledger. */
interface Pending {
  turns: RawTurn[];
  lastGrowth: number;
  offset: number;
}

const MAX_TURNS_PER_BATCH = 24;
const MAX_CHARS_PER_TURN = 4000;
const WATCH_STATE_FILE = "watch.json";

/** Offered when no model is available; each button runs the command that fixes it. */
const SET_KEY_ACTIONS: Record<string, string> = {
  "Set Vertex AI (Gemini) API Key": "ledger.setGeminiApiKey",
  "Set Anthropic API Key": "ledger.setApiKey",
};

export class AgentWatcher implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private pending = new Map<string, Pending>();
  /** Per session file, so one failing file doesn't slow the healthy ones. */
  private fileBackoffs = new Map<string, RetryBackoff>();
  /** For failures before any file is reached (e.g. listing the projects folder). */
  private scanBackoff = new RetryBackoff();
  /** The key-setup warning currently shown, so several files failing for want of a model show it once. */
  private shownWarning: string | undefined;

  constructor(
    private ctx: vscode.ExtensionContext,
    private ledger: () => Ledger,
    private workspace: string,
    private log: vscode.OutputChannel,
    private onChange: () => void
  ) {}

  start() {
    this.stop();
    const secs = vscode.workspace.getConfiguration("ledger").get<number>("agents.pollSeconds", 5);
    this.timer = setInterval(() => this.tick(), secs * 1000);
    this.log.appendLine(`Watching Claude Code sessions for ${this.workspace}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running() {
    return !!this.timer;
  }

  /** Skip the remaining backoff, e.g. right after the user sets an API key. */
  retryNow() {
    this.fileBackoffs.clear();
    this.scanBackoff.reset();
    this.shownWarning = undefined;
  }

  dispose() {
    this.stop();
  }

  private projectsDir(): string {
    const p = vscode.workspace.getConfiguration("ledger").get<string>("agents.claudeProjectsDir", "");
    return p || path.join(os.homedir(), ".claude", "projects");
  }

  private async tick() {
    if (this.busy || !this.scanBackoff.canTry(Date.now())) return;
    this.busy = true;
    try {
      await this.scan();
      this.scanBackoff.reset();
    } catch (e) {
      this.reportFailure("scan", this.scanBackoff, e);
    } finally {
      this.busy = false;
    }
  }

  /** Scans every session file that isn't backing off; each file's failures are its own. */
  private async scan() {
    const ledger = this.ledger();
    const state = ledger.readMeta<WatchState>(WATCH_STATE_FILE, {});
    for (const file of findSessionFiles(this.projectsDir(), this.workspace)) {
      const backoff = this.backoffFor(file);
      if (!backoff.canTry(Date.now())) continue;
      try {
        if (await this.scanFile(ledger, file, state)) {
          backoff.reset();
          this.shownWarning = undefined;
        }
      } catch (e) {
        this.reportFailure(path.basename(file, ".jsonl").slice(0, 8), backoff, e);
      }
    }
  }

  private backoffFor(file: string): RetryBackoff {
    let backoff = this.fileBackoffs.get(file);
    if (!backoff) this.fileBackoffs.set(file, (backoff = new RetryBackoff()));
    return backoff;
  }

  /** Reads new turns and flushes them once the agent goes quiet (or the batch gets large). Returns whether a model was called. */
  private async scanFile(ledger: Ledger, file: string, state: WatchState): Promise<boolean> {
    const size = fs.statSync(file).size;
    if (!state[file]) {
      const importExisting = vscode.workspace.getConfiguration("ledger").get<boolean>("agents.importExisting", false);
      state[file] = { offset: importExisting ? 0 : size };
      ledger.writeMeta(WATCH_STATE_FILE, state);
    }
    const pend = this.readNewTurns(file, state[file].offset, size);
    const idleMs = vscode.workspace.getConfiguration("ledger").get<number>("agents.idleSeconds", 20) * 1000;
    const isQuiet = Date.now() - pend.lastGrowth > idleMs;
    if (pend.offset <= state[file].offset || !(isQuiet || pend.turns.length >= MAX_TURNS_PER_BATCH)) return false;
    const didIngest = await this.flush(ledger, file, pend, state);
    state[file].offset = pend.offset;
    ledger.writeMeta(WATCH_STATE_FILE, state);
    return didIngest;
  }

  /** Reads complete new lines since the last read; a half-written last line waits for the next tick. */
  private readNewTurns(file: string, savedOffset: number, size: number): Pending {
    const pend = this.pending.get(file) ?? { turns: [], lastGrowth: Date.now(), offset: savedOffset };
    this.pending.set(file, pend);
    if (size <= pend.offset) return pend;
    const buffer = Buffer.alloc(size - pend.offset);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, pend.offset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return pend;
    const complete = text.slice(0, lastNewline + 1);
    appendTurns(pend.turns, parseClaudeCodeLines(complete.split("\n"), pend.offset));
    pend.offset += Buffer.byteLength(complete, "utf8");
    pend.lastGrowth = Date.now();
    return pend;
  }

  /**
   * Commits the backlog batch by batch, saving the safe offset after each one, so a
   * failure or reload part-way neither loses nor repeats turns (except inside a single
   * turn longer than a batch; see core/batches). Returns whether a model was called.
   */
  private async flush(ledger: Ledger, file: string, pend: Pending, state: WatchState): Promise<boolean> {
    pend.turns = chunkTurns(pend.turns, MAX_CHARS_PER_TURN);
    if (!pend.turns.length) return false;
    const session = pend.turns.find((t) => t.session)?.session || path.basename(file, ".jsonl");
    const model = await getEngine(this.ctx);
    await ingestBacklog(ledger, pend.turns, model, { origin: "claude-code", session }, MAX_TURNS_PER_BATCH, (batch) => {
      const outcome = batch.result ? `${batch.result.records.length} decisions, node ${batch.result.node.slice(0, 7)}` : "no decisions";
      this.log.appendLine(`claude-code ${session.slice(0, 8)}: ${batch.turns} turns → ${outcome}`);
      if (batch.result) this.onChange();
      if (batch.safeOffset === undefined) return;
      state[file].offset = batch.safeOffset;
      ledger.writeMeta(WATCH_STATE_FILE, state);
    });
    return true;
  }

  /** Logs each distinct failure once per source; repeats only push that source's next retry further out. */
  private reportFailure(source: string, backoff: RetryBackoff, error: unknown) {
    if (!backoff.fail(failureKey(error), Date.now())) return;
    const message = error instanceof Error ? error.message : String(error);
    this.log.appendLine(`watcher error (${source}): ${message} (retrying with backoff; repeats are not logged)`);
    if (error instanceof NoModelError && this.shownWarning !== message) {
      this.shownWarning = message;
      this.offerKeySetup(message).catch((e) => this.log.appendLine(`could not open key setup: ${e?.message ?? e}`));
    }
  }

  /** Only a missing model is worth interrupting the user for: they're the one who can fix it. */
  private async offerKeySetup(message: string) {
    const pick = await vscode.window.showWarningMessage(`Decision Ledger can't process agent sessions: ${message}`, ...Object.keys(SET_KEY_ACTIONS));
    if (pick) await vscode.commands.executeCommand(SET_KEY_ACTIONS[pick]);
  }
}

/** Stable identity for an error: API failures differ per request (ids in the body), so key them by provider and status. */
function failureKey(error: unknown): string {
  if (error instanceof ApiError) return `${error.provider} API ${error.status}`;
  return error instanceof Error ? error.message : String(error);
}
