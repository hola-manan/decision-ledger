/**
 * The Filter view above the decisions tree (D-021): the VS Code side. It shows the
 * sliders, validates what they send, and keeps GradeFilter in step with config.json.
 */
import * as vscode from "vscode";
import { ConfigError } from "../core";
import { parseFilterMessage, type FilterHostMessage, type FilterParameter, type FilterWebviewMessage } from "../protocol";
import type { DecisionCounts, GradeFilter } from "./grade-filter";
import { filterHtml, WEBVIEW_OUT_DIR } from "./html";

export const FILTER_VIEW_ID = "ledger.filter";
/** Shown when reading the parameters fails for a reason other than the config file's content. */
const UNEXPECTED_ERROR = "Something went wrong reading .ledger/config.json. Details are in the Decision Ledger output.";

export interface FilterViewOptions {
  extensionUri: vscode.Uri;
  filter: GradeFilter;
  /** The current parameters; throws when config.json can't be used. Must not write anything. */
  parameters: () => FilterParameter[];
  counts: () => DecisionCounts;
  editParameters: () => void;
  log: (line: string) => void;
}

export class FilterViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private parameters: FilterParameter[] = [];
  private problem: string | undefined;

  constructor(private readonly options: FilterViewOptions) {}

  /** Re-reads the parameters; call before the tree asks for its rows. A broken config turns the filter off. */
  syncParameters(): void {
    try {
      this.parameters = this.options.parameters();
      this.problem = undefined;
    } catch (error) {
      this.parameters = [];
      this.problem = error instanceof ConfigError ? error.message : UNEXPECTED_ERROR;
      this.options.log(`grade filter is off: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    this.options.filter.syncParameters(this.parameters.map((p) => p.id));
  }

  /** Sends the current state to the view, if it is open. */
  postState(): void {
    if (!this.view) return;
    this.view.webview.postMessage(this.stateMessage()).then(undefined, (e) => this.options.log(`filter view: ${e?.message ?? e}`));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, ...WEBVIEW_OUT_DIR)] };
    view.webview.html = filterHtml(view.webview, this.options.extensionUri);
    view.webview.onDidReceiveMessage((raw) => this.onMessage(raw));
    view.onDidDispose(() => (this.view = undefined));
  }

  private onMessage(raw: unknown): void {
    const message = parseFilterMessage(raw);
    if (!message) return this.options.log(`filter view sent an unknown message: ${JSON.stringify(raw)}`);
    this.handle(message);
  }

  private handle(message: FilterWebviewMessage): void {
    switch (message.type) {
      case "ready":
        return this.postState();
      case "setRange":
        return this.options.filter.setRange(message.id, message.range);
      case "reset":
        return this.options.filter.reset();
      case "editParameters":
        return this.options.editParameters();
    }
  }

  private stateMessage(): FilterHostMessage {
    if (this.problem) return { type: "error", message: this.problem };
    const filter = this.options.filter;
    return { type: "state", scale: filter.scale, parameters: this.parameters, ranges: filter.ranges, isActive: filter.isActive, ...this.options.counts() };
  }
}
