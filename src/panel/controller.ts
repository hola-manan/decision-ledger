/**
 * The Live Session view: the VS Code side only. It builds the HTML, implements the two
 * ports (WebviewPort, HostCommands) with VS Code APIs, and hands everything else to
 * SessionPanel. The panel starts the first time the view is shown, and then keeps its
 * session and badge current while hidden.
 */
import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { localHumanName, type Ledger } from "../core";
import type { SessionLogSource, Unsubscribe } from "../claude-log";
import type { AgentWatcher } from "../watcher";
import type { HostCommands } from "./actions";
import { SessionFollower, type FollowChoice } from "./follower";
import { panelHtml } from "./html";
import { DecisionLinker } from "./linker";
import { SessionPanel, type Clock, type WebviewPort } from "./session-panel";
import { PROTOCOL_VERSION } from "../protocol";

export const PANEL_VIEW_ID = "ledger.panel";
const FOLLOW_CHOICE_KEY = "ledger.panel.follow";
const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";
const NONCE_BYTES = 16;
/** Built by tsconfig.webview.json and scripts/copy-webview-assets.mjs. */
const BROWSER_OUT = ["out", "browser"];

export interface PanelDeps {
  source: SessionLogSource;
  watcher: AgentWatcher;
  ledger: () => Ledger;
  workspace: string;
  log: vscode.OutputChannel;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class PanelController implements vscode.WebviewViewProvider, WebviewPort, HostCommands, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private panel: SessionPanel | undefined;
  private follower: SessionFollower | undefined;
  private lease: Unsubscribe | undefined;
  private badge: vscode.ViewBadge | undefined;
  private humanName: string | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: PanelDeps
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.ctx.extensionUri, ...BROWSER_OUT);
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [root] };
    view.webview.onDidReceiveMessage((message) => this.start().receive(message));
    view.onDidDispose(() => (this.view = undefined));
    view.badge = this.badge;
    this.reload();
    this.start();
  }

  /** The ledger or the watcher changed: the panel updates the decisions it shows. */
  ledgerChanged(): void {
    this.panel?.ledgerChanged();
  }

  chooseSession(): void {
    this.start().receive({ v: PROTOCOL_VERSION, type: "chooseSession", requestId: "command" });
  }

  followLatest(): void {
    this.start();
    this.follower?.followLatest();
  }

  dispose(): void {
    this.panel?.dispose();
    this.follower?.dispose();
    this.lease?.dispose();
  }

  // ---------- WebviewPort ----------

  post(message: unknown): void {
    this.view?.webview.postMessage(message).then(undefined, (e) => this.deps.log.appendLine(`panel: couldn't post: ${e?.message ?? e}`));
  }

  setBadge(count: number, tooltip: string): void {
    this.badge = count > 0 ? { value: count, tooltip } : undefined;
    if (this.view) this.view.badge = this.badge;
  }

  // ---------- HostCommands ----------

  async openRecord(hash: string): Promise<void> {
    await vscode.commands.executeCommand("ledger.openRecord", hash);
  }

  /** Until the tree can reveal a node (build step 18), this opens the node's state document. */
  async revealNode(hash: string): Promise<void> {
    await vscode.commands.executeCommand("ledger.showState", hash);
  }

  async openFile(absolutePath: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: true });
  }

  async setUpModel(): Promise<void> {
    await vscode.commands.executeCommand("ledger.setUpModel");
  }

  async editParameters(): Promise<void> {
    await vscode.commands.executeCommand("ledger.editParameters");
  }

  async enableExtraction(): Promise<void> {
    this.deps.watcher.start();
    this.ledgerChanged();
  }

  showOutput(): void {
    this.deps.log.show(true);
  }

  async pickSession(items: { sessionId: string; label: string; detail: string }[]): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Show which Claude Code session?" });
    return picked?.sessionId;
  }

  reload(): void {
    if (!this.view) return;
    const webview = this.view.webview;
    const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...BROWSER_OUT, "webview", ...parts)).toString();
    webview.html = panelHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(NONCE_BYTES).toString("base64"),
      scriptUri: asset("main.js"),
      styleUris: [asset("styles", "tokens.css"), asset("styles", "panel.css")],
    });
  }

  isClaudeCodeInstalled(): boolean {
    return vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID) !== undefined;
  }

  // ---------- wiring ----------

  /** Starts following on first use: the panel following a session is what makes it "used" (D-020). */
  private start(): SessionPanel {
    if (this.panel) return this.panel;
    const { deps, ctx } = this;
    this.lease = deps.source.acquire();
    const saved = ctx.workspaceState.get<FollowChoice>(FOLLOW_CHOICE_KEY, { mode: "auto" });
    this.follower = new SessionFollower(deps.source, saved, (choice) => void ctx.workspaceState.update(FOLLOW_CHOICE_KEY, choice));
    this.panel = new SessionPanel({
      source: deps.source,
      follower: this.follower,
      status: deps.watcher,
      linker: new DecisionLinker(deps.ledger),
      ledger: deps.ledger,
      port: this,
      host: this,
      clock: realClock,
      workspace: deps.workspace,
      humanName: () => (this.humanName ??= localHumanName(deps.workspace)),
      isExtractionEnabled: () => deps.watcher.running,
      useSession: (file) => deps.watcher.useSession(file),
      log: (line) => deps.log.appendLine(line),
    });
    return this.panel;
  }
}

/** Registers the Live Session view and its commands. */
export function registerPanel(ctx: vscode.ExtensionContext, deps: PanelDeps): PanelController {
  const controller = new PanelController(ctx, deps);
  ctx.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, controller),
    vscode.commands.registerCommand("ledger.chooseSession", () => controller.chooseSession()),
    vscode.commands.registerCommand("ledger.followLatestSession", () => controller.followLatest()),
    vscode.commands.registerCommand("ledger.setUpModel", () => setUpModel())
  );
  return controller;
}

/** One place to get a model working: the three existing ways, as a quick pick. */
async function setUpModel(): Promise<void> {
  const choices = [
    { label: "Use GitHub Copilot Chat", detail: "No key needed if Copilot Chat is installed and signed in.", run: () => useCopilot() },
    { label: "Set Anthropic API Key", detail: "Stored in VS Code's secret storage.", run: () => vscode.commands.executeCommand("ledger.setApiKey") },
    { label: "Set Vertex AI (Gemini) API Key", detail: "Stored in VS Code's secret storage.", run: () => vscode.commands.executeCommand("ledger.setGeminiApiKey") },
  ];
  const picked = await vscode.window.showQuickPick(choices, { placeHolder: "How should Decision Ledger find decisions?" });
  await picked?.run();
}

async function useCopilot(): Promise<void> {
  await vscode.workspace.getConfiguration("ledger").update("engine.provider", "vscode", vscode.ConfigurationTarget.Global);
}
