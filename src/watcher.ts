/**
 * Output 3 — autonomous agents. Tails Claude Code session logs for this workspace and
 * replaces the long trail with ordered decision records.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Ledger } from "./core/store";
import { findSessionFiles, parseClaudeCodeLines, RawTurn } from "./core/transcript";
import { ingest } from "./core/ingest";
import { getEngine } from "./provider";

interface FileState {
  offset: number;
}
type WatchState = Record<string, FileState>;

const MAX_TURNS_PER_BATCH = 24;
const MAX_CHARS_PER_TURN = 4000;

export class AgentWatcher implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private pending = new Map<string, { turns: RawTurn[]; lastGrowth: number; offset: number }>();

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
    this.timer = setInterval(() => this.tick().catch((e) => this.log.appendLine(`watcher error: ${e?.message ?? e}`)), secs * 1000);
    this.log.appendLine(`Watching Claude Code sessions for ${this.workspace}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running() {
    return !!this.timer;
  }

  dispose() {
    this.stop();
  }

  private projectsDir(): string {
    const p = vscode.workspace.getConfiguration("ledger").get<string>("agents.claudeProjectsDir", "");
    return p || path.join(os.homedir(), ".claude", "projects");
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const ledger = this.ledger();
      const state = ledger.readMeta<WatchState>("watch.json", {});
      const importExisting = vscode.workspace.getConfiguration("ledger").get<boolean>("agents.importExisting", false);
      const idleMs = vscode.workspace.getConfiguration("ledger").get<number>("agents.idleSeconds", 20) * 1000;
      let dirty = false;

      for (const file of findSessionFiles(this.projectsDir(), this.workspace)) {
        const size = fs.statSync(file).size;
        if (!state[file]) {
          state[file] = { offset: importExisting ? 0 : size };
          dirty = true;
        }
        const pend = this.pending.get(file) ?? { turns: [], lastGrowth: Date.now(), offset: state[file].offset };
        if (size > pend.offset) {
          const fd = fs.openSync(file, "r");
          const buf = Buffer.alloc(size - pend.offset);
          fs.readSync(fd, buf, 0, buf.length, pend.offset);
          fs.closeSync(fd);
          const text = buf.toString("utf8");
          const lastNl = text.lastIndexOf("\n");
          if (lastNl >= 0) {
            const complete = text.slice(0, lastNl + 1);
            pend.turns.push(...parseClaudeCodeLines(complete.split("\n")));
            pend.offset += Buffer.byteLength(complete, "utf8");
            pend.lastGrowth = Date.now();
          }
        }
        this.pending.set(file, pend);

        // Flush once the agent goes quiet (or the batch gets large).
        const quiet = Date.now() - pend.lastGrowth > idleMs;
        if (pend.offset > state[file].offset && (quiet || pend.turns.length >= MAX_TURNS_PER_BATCH)) {
          await this.flush(ledger, file, pend.turns);
          state[file].offset = pend.offset;
          pend.turns = [];
          dirty = true;
        }
      }
      if (dirty) ledger.writeMeta("watch.json", state);
    } finally {
      this.busy = false;
    }
  }

  private async flush(ledger: Ledger, file: string, turns: RawTurn[]) {
    if (!turns.length) return;
    const session = turns.find((t) => t.session)?.session || path.basename(file, ".jsonl");
    const engine = await getEngine(this.ctx);
    for (let i = 0; i < turns.length; i += MAX_TURNS_PER_BATCH) {
      const batch = turns.slice(i, i + MAX_TURNS_PER_BATCH).map((t) => ({ ...t, text: t.text.slice(0, MAX_CHARS_PER_TURN) }));
      const r = await ingest(ledger, batch, engine, { origin: "claude-code", session });
      this.log.appendLine(`claude-code ${session.slice(0, 8)}: ${batch.length} turns → ${r ? r.records.length + " decisions, node " + r.node.slice(0, 7) : "no decisions"}`);
      if (r) this.onChange();
    }
  }
}
