/**
 * Autonomous agents: turns this workspace's Claude Code sessions into ordered decision
 * records. The VS Code side only: settings, the model, and warnings with fixes. The work
 * is done by ExtractionPipeline.
 */
import * as vscode from "vscode";
import { NoModelError } from "../../engine/src";
import { ConfigError, localHumanName, type Ledger } from "../core";
import type { SessionLogSource, Unsubscribe } from "../claude-log";
import { getEngine } from "../provider";
import { ExtractionPipeline } from "./pipeline";
import type { ExtractionStatus, ExtractionStatusProvider } from "./status";

const DEFAULT_IDLE_SECONDS = 20;
const DEFAULT_POLL_SECONDS = 5;
const MS_PER_SECOND = 1000;

/** Offered when no model is available; each button runs the command that fixes it. */
const SET_KEY_ACTIONS: Record<string, string> = {
  "Set Vertex AI (Gemini) API Key": "ledger.setGeminiApiKey",
  "Set Anthropic API Key": "ledger.setApiKey",
};

/** Offered when .ledger/config.json can't be used. */
const EDIT_CONFIG_ACTIONS: Record<string, string> = {
  "Edit Decision Parameters": "ledger.editParameters",
};

export class AgentWatcher implements ExtractionStatusProvider, vscode.Disposable {
  private readonly pipeline: ExtractionPipeline;
  /** The warning currently shown, so several files failing the same way show it once. */
  private shownWarning: string | undefined;
  /** Looked up once: the person at this machine is the human in these sessions. */
  private humanName: string | undefined;

  constructor(
    ctx: vscode.ExtensionContext,
    ledger: () => Ledger,
    source: SessionLogSource,
    private readonly workspace: string,
    private readonly log: vscode.OutputChannel,
    onChange: () => void
  ) {
    this.pipeline = new ExtractionPipeline({
      ledger,
      source,
      model: () => getEngine(ctx),
      humanName: () => (this.humanName ??= localHumanName(this.workspace)),
      idleMs: () => setting("agents.idleSeconds", DEFAULT_IDLE_SECONDS) * MS_PER_SECOND,
      checkEveryMs: setting("agents.pollSeconds", DEFAULT_POLL_SECONDS) * MS_PER_SECOND,
      log: (line) => log.appendLine(line),
      onCommitted: onChange,
      onFailure: (error) => this.offerFixFor(error),
      onRecovered: () => (this.shownWarning = undefined),
    });
  }

  start(): void {
    if (this.pipeline.isRunning) return;
    this.pipeline.start();
    this.log.appendLine(`Watching Claude Code sessions for ${this.workspace}`);
  }

  stop(): void {
    this.pipeline.stop();
  }

  get running(): boolean {
    return this.pipeline.isRunning;
  }

  /** Skip the remaining backoff, e.g. right after the user sets an API key. */
  retryNow(): void {
    this.shownWarning = undefined;
    this.pipeline.retryNow();
  }

  status(file: string): ExtractionStatus {
    return this.pipeline.status(file);
  }

  onDidChangeStatus(listener: (file: string) => void): Unsubscribe {
    return this.pipeline.onDidChangeStatus(listener);
  }

  useSession(file: string): void {
    this.pipeline.useSession(file);
  }

  dispose(): void {
    this.stop();
  }

  private offerFixFor(error: unknown): void {
    const fixes = userFixes(error);
    const message = error instanceof Error ? error.message : String(error);
    if (!fixes || this.shownWarning === message) return;
    this.shownWarning = message;
    vscode.window
      .showWarningMessage(`Decision Ledger can't process agent sessions: ${message}`, ...Object.keys(fixes))
      .then((pick) => pick && vscode.commands.executeCommand(fixes[pick]))
      .then(undefined, (e) => this.log.appendLine(`could not offer a fix: ${e?.message ?? e}`));
  }
}

function setting(key: string, fallback: number): number {
  return vscode.workspace.getConfiguration("ledger").get<number>(key, fallback);
}

/**
 * Only failures the user can fix are worth interrupting them for: a missing model, or a
 * broken parameters file (which otherwise stops all recording without a visible sign).
 */
function userFixes(error: unknown): Record<string, string> | undefined {
  if (error instanceof NoModelError) return SET_KEY_ACTIONS;
  if (error instanceof ConfigError) return EDIT_CONFIG_ACTIONS;
  return undefined;
}
