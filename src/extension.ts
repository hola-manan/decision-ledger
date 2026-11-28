import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { GRADE_MAX, GRADE_MIN } from "../engine/src";
import { CONFIG_FILE, ensureConfigFile, Ledger, readParameters, shortHash, type DecisionRecord, type LedgerNode } from "./core";
import { FILTER_VIEW_ID, FilterViewProvider, GradeFilter, type DecisionCounts } from "./filter";
import { registerChat } from "./chat";
import { AgentWatcher } from "./watcher";
import { registerPanel, type PanelController } from "./panel";
import { createSessionLogSource } from "./claude-log";
import { GEMINI_SECRET_KEY, SECRET_KEY } from "./provider";
import { diffDoc, gradesText, recordDoc, stateDoc, who } from "./render";

function claudeProjectsDir(): string {
  const configured = vscode.workspace.getConfiguration("ledger").get<string>("agents.claudeProjectsDir", "");
  return configured || path.join(os.homedir(), ".claude", "projects");
}

/** workspaceState keys: the grade filter is remembered per project (D-021). */
const FILTER_RANGES_KEY = "ledger.gradeFilter.ranges";
const FILTER_VISIBLE_KEY = "ledger.gradeFilter.visible";

function recordTooltip(ledger: Ledger, r: DecisionRecord): string {
  const parts = [`**${r.decision}**`, who(r.author)];
  const grades = gradesText(ledger, r);
  if (grades) parts.push(grades);
  if (r.rationale) parts.push(`_${r.rationale}_`);
  if (r.source.quote) parts.push(`> ${r.source.quote}`);
  return parts.join("\n\n");
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Item = { kind: "node"; hash: string; node: LedgerNode } | { kind: "record"; hash: string; record: DecisionRecord; dead: boolean };

class TreeProvider implements vscode.TreeDataProvider<Item> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** The grade filter hides records, and nodes left with none; it never reorders (D-021). */
  constructor(private ledger: () => Ledger, private filter: GradeFilter) {}
  refresh() {
    this.emitter.fire();
  }

  getChildren(el?: Item): Item[] {
    const l = this.ledger();
    if (!el) {
      return l
        .log()
        .filter(({ node }) => this.filter.showsAny(() => l.records(node.added).map((r) => r.record.grades)))
        .map(({ hash, node }) => ({ kind: "node", hash, node }));
    }
    if (el.kind === "node") {
      const dead = new Set(l.stateAt().map((r) => r.record.supersedes).filter(Boolean));
      return l
        .records(el.node.added)
        .filter((r) => this.filter.shows(r.record.grades))
        .map((r) => ({ kind: "record", ...r, dead: dead.has(r.hash) }));
    }
    return [];
  }

  /** Records on this branch, and how many of them the filter shows. */
  counts(): DecisionCounts {
    const l = this.ledger();
    return this.filter.count(l.log().flatMap(({ node }) => l.records(node.added).map((r) => r.record.grades)));
  }

  getTreeItem(el: Item): vscode.TreeItem {
    if (el.kind === "node") {
      const t = new vscode.TreeItem(el.node.message, vscode.TreeItemCollapsibleState.Collapsed);
      t.description = `${shortHash(el.hash)} · +${el.node.added.length} · ${el.node.origin} · ${ago(el.node.timestamp)}`;
      t.iconPath = new vscode.ThemeIcon("git-commit");
      t.contextValue = "node";
      t.tooltip = `${el.hash}\n${el.node.state.length} decisions in state`;
      return t;
    }
    const r = el.record;
    const t = new vscode.TreeItem(`#${r.seq} ${r.decision}`);
    t.description = r.author.name + (el.dead ? " · superseded" : "");
    t.iconPath = new vscode.ThemeIcon(r.author.kind === "human" ? "person" : "hubot", el.dead ? new vscode.ThemeColor("disabledForeground") : undefined);
    t.tooltip = new vscode.MarkdownString(recordTooltip(this.ledger(), r));
    t.command = { command: "ledger.openRecord", title: "Open source", arguments: [el.hash] };
    t.contextValue = "record";
    return t;
  }
}

async function showMarkdown(content: string) {
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
}

export function activate(ctx: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ctx.globalStorageUri.fsPath;
  let ledger: Ledger | undefined;
  const getLedger = () => (ledger ??= Ledger.open(root));
  const out = vscode.window.createOutputChannel("Decision Ledger");

  const filter = new GradeFilter(
    { get: () => ctx.workspaceState.get(FILTER_RANGES_KEY), set: (ranges) => void ctx.workspaceState.update(FILTER_RANGES_KEY, ranges) },
    { min: GRADE_MIN, max: GRADE_MAX },
    // Only called on a user's change, after activation, by which time showFilterResult exists.
    () => showFilterResult()
  );
  const tree = new TreeProvider(getLedger, filter);
  const filterView = new FilterViewProvider({
    extensionUri: ctx.extensionUri,
    filter,
    parameters: () => readParameters(getLedger()).map(({ id, name, low, high }) => ({ id, name, low, high })),
    counts: () => tree.counts(),
    editParameters: () => void vscode.commands.executeCommand("ledger.editParameters"),
    log: (line) => out.appendLine(line),
  });
  const view = vscode.window.createTreeView("ledger.tree", { treeDataProvider: tree });
  /** After the filter changes: the tree, its title and the strip's count. config.json isn't re-read. */
  const showFilterResult = () => {
    tree.refresh();
    const l = getLedger();
    const branch = l.currentBranch() ? `on ${l.currentBranch()}` : `detached ${shortHash(l.head() ?? "")}`;
    view.description = filter.isActive ? `${branch} · filtered` : branch;
    void vscode.commands.executeCommand("setContext", "ledger.filterActive", filter.isActive);
    filterView.postState();
  };
  /** Set once the Live Session view is registered; it shows the decisions too. */
  let panel: PanelController | undefined;
  const refresh = () => {
    filterView.syncParameters();
    showFilterResult();
    panel?.ledgerChanged();
  };
  refresh();
  const isFilterVisible = () => ctx.workspaceState.get<boolean>(FILTER_VISIBLE_KEY, false);
  const toggleFilter = () => {
    const isVisible = !isFilterVisible();
    void ctx.workspaceState.update(FILTER_VISIBLE_KEY, isVisible);
    void vscode.commands.executeCommand("setContext", "ledger.filterVisible", isVisible);
    if (isVisible) void vscode.commands.executeCommand(`${FILTER_VIEW_ID}.focus`);
  };
  void vscode.commands.executeCommand("setContext", "ledger.filterVisible", isFilterVisible());

  // Keep the view live when the CLI or another window writes to .ledger/
  const fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".ledger/{HEAD,refs/**}"));
  fsw.onDidChange(refresh);
  fsw.onDidCreate(refresh);

  registerChat(ctx, getLedger, refresh);

  // One reader of Claude Code's logs, shared by everything that needs them (D-003).
  const source = createSessionLogSource({
    projectsDir: claudeProjectsDir(),
    workspace: root,
    pollMs: vscode.workspace.getConfiguration("ledger").get<number>("agents.pollSeconds", 5) * 1000,
  });
  const watcher = new AgentWatcher(ctx, getLedger, source, root, out, refresh);
  if (vscode.workspace.workspaceFolders && vscode.workspace.getConfiguration("ledger").get("agents.watchClaudeCode", true)) watcher.start();
  panel = registerPanel(ctx, { source, watcher, ledger: getLedger, workspace: root, log: out });
  // A new key or engine setting may fix a failing watcher; don't make it wait out the backoff.
  // Nor should a fixed .ledger/config.json.
  const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `.ledger/${CONFIG_FILE}`));
  ctx.subscriptions.push(
    configWatcher,
    configWatcher.onDidChange(() => (watcher.retryNow(), refresh())),
    configWatcher.onDidCreate(() => (watcher.retryNow(), refresh())),
    ctx.secrets.onDidChange(() => watcher.retryNow()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ledger.engine")) watcher.retryNow();
    })
  );

  const pickNode = async (item?: Item): Promise<string | undefined> => {
    if (item?.kind === "node") return item.hash;
    const log = getLedger().log();
    const p = await vscode.window.showQuickPick(
      log.map((l) => ({ label: l.node.message, description: `${shortHash(l.hash)} · +${l.node.added.length}`, hash: l.hash })),
      { placeHolder: "Pick a node" }
    );
    return p?.hash;
  };

  const run = (fn: (...a: any[]) => unknown) => async (...a: any[]) => {
    try {
      await fn(...a);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Ledger: ${e?.message ?? e}`);
    }
  };

  ctx.subscriptions.push(
    out, view, fsw, watcher, source,
    vscode.window.registerWebviewViewProvider(FILTER_VIEW_ID, filterView),
    vscode.commands.registerCommand("ledger.toggleFilter", toggleFilter),
    vscode.commands.registerCommand("ledger.toggleFilterNarrowed", toggleFilter),
    vscode.commands.registerCommand("ledger.resetFilter", () => filter.reset()),
    vscode.commands.registerCommand("ledger.refresh", refresh),
    vscode.commands.registerCommand("ledger.openRecord", run((hash: string) => showMarkdown(recordDoc(getLedger(), hash)))),
    vscode.commands.registerCommand("ledger.showText", run((text: string) => showMarkdown(text))),
    vscode.commands.registerCommand(
      "ledger.showState",
      run(async (arg?: Item | string) => {
        const h = typeof arg === "string" ? arg : (await pickNode(arg)) ?? undefined;
        if (h) await showMarkdown(stateDoc(getLedger(), h));
      })
    ),
    vscode.commands.registerCommand(
      "ledger.showCurrent",
      run(async () => {
        const h = getLedger().head();
        if (!h) return vscode.window.showInformationMessage("No decisions recorded yet.");
        await showMarkdown(stateDoc(getLedger(), h));
      })
    ),
    vscode.commands.registerCommand(
      "ledger.diffParent",
      run(async (item?: Item) => {
        const h = await pickNode(item);
        if (h) await showMarkdown(diffDoc(getLedger(), getLedger().get<LedgerNode>(h).parent, h));
      })
    ),
    vscode.commands.registerCommand(
      "ledger.branchHere",
      run(async (item?: Item) => {
        const h = await pickNode(item);
        if (!h) return;
        const name = await vscode.window.showInputBox({ prompt: `New branch from ${shortHash(h)}` });
        if (!name) return;
        getLedger().createBranch(name, h);
        getLedger().checkout(name);
        refresh();
      })
    ),
    vscode.commands.registerCommand(
      "ledger.checkout",
      run(async () => {
        const p = await vscode.window.showQuickPick(
          getLedger().branches().map((b) => ({ label: b.name, description: (b.current ? "current · " : "") + shortHash(b.head ?? "") })),
          { placeHolder: "Switch branch" }
        );
        if (p) {
          getLedger().checkout(p.label);
          refresh();
        }
      })
    ),
    vscode.commands.registerCommand("ledger.setApiKey", run(() => promptForApiKey(ctx, SECRET_KEY, "Anthropic"))),
    vscode.commands.registerCommand("ledger.setGeminiApiKey", run(() => promptForApiKey(ctx, GEMINI_SECRET_KEY, "Gemini (Vertex AI express mode)"))),
    vscode.commands.registerCommand(
      "ledger.editParameters",
      run(async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(ensureConfigFile(getLedger())));
      })
    ),
    vscode.commands.registerCommand("ledger.toggleAgentWatch", () => {
      if (watcher.running) watcher.stop();
      else watcher.start();
      refresh();
      vscode.window.showInformationMessage(`Ledger: agent watching ${watcher.running ? "on" : "off"}.`);
    })
  );
}

export function deactivate() {}

/** Store (or, if left empty, remove) an API key in VS Code's secret storage. */
async function promptForApiKey(ctx: vscode.ExtensionContext, secretKey: string, providerName: string) {
  const key = await vscode.window.showInputBox({ prompt: `${providerName} API key (stored in VS Code secret storage)`, password: true });
  if (key === undefined) return;
  const trimmed = key.trim();
  if (trimmed) await ctx.secrets.store(secretKey, trimmed);
  else await ctx.secrets.delete(secretKey);
  vscode.window.showInformationMessage(`Ledger: ${providerName} API key ${trimmed ? "saved" : "removed"}.`);
}
