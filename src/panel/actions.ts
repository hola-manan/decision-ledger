/**
 * What each webview action does (api.md §1, "Webview → host"). Every argument is checked
 * against the current model first: the webview can only name records, nodes, files and
 * exchanges the panel is showing.
 */
import { nativePath, type SessionFile } from "../claude-log";
import type { PanelError, WebviewMessage } from "../protocol";
import { extractionOff, noSessionFound, notFound } from "./errors";
import { collectFileChanges } from "./files";
import type { FollowedSession } from "./followed-session";
import type { SessionFollower } from "./follower";
import type { LinkedDecision } from "./linker";
import { displayPath } from "./paths";

/** The panel's ways of changing VS Code. Implemented by the controller; faked in tests. */
export interface HostCommands {
  openRecord(hash: string): Promise<void>;
  revealNode(hash: string): Promise<void>;
  openFile(absolutePath: string): Promise<void>;
  setUpModel(): Promise<void>;
  editParameters(): Promise<void>;
  enableExtraction(): Promise<void>;
  showOutput(): void;
  pickSession(items: { sessionId: string; label: string; detail: string }[]): Promise<string | undefined>;
  /** Re-render the webview's HTML (after a protocol version mismatch). */
  reload(): void;
  isClaudeCodeInstalled(): boolean;
}

export interface ActionContext {
  host: HostCommands;
  follower: SessionFollower;
  workspace: string;
  session(): FollowedSession | undefined;
  linked(): ReadonlyMap<string, readonly LinkedDecision[]>;
  sessions(): readonly SessionFile[];
  isExtractionEnabled(): boolean;
  retryExtraction(): void;
  rescan(): void;
  /** Sends the exchanges before this one; false if it isn't known. */
  sendEarlier(beforeExchangeId: string): boolean;
  now(): number;
}

/** The actions that get an actionResult. */
export type ActionMessage = Exclude<WebviewMessage, { type: "ready" | "protocolError" | "reloadRequest" }>;

/** Runs one action; null means it worked. A command that throws becomes ACTION_FAILED (the caller logs it). */
export async function runAction(message: ActionMessage, context: ActionContext): Promise<PanelError | null> {
  const { host } = context;
  switch (message.type) {
    case "openRecord":
      return isLinkedRecord(context, message.recordId) ? done(host.openRecord(message.recordId)) : notFound("decision");
    case "revealNode":
      return isLinkedNode(context, message.nodeId) ? done(host.revealNode(message.nodeId)) : notFound("node");
    case "openFile": {
      const file = changedFile(context, message.exchangeId, message.path);
      return file ? done(host.openFile(file)) : notFound("file");
    }
    case "retryExtraction":
      if (!context.isExtractionEnabled()) return extractionOff();
      context.retryExtraction();
      return null;
    case "setUpModel":
      return done(host.setUpModel());
    case "editParameters":
      return done(host.editParameters());
    case "enableExtraction":
      return done(host.enableExtraction());
    case "chooseSession":
      return chooseSession(context);
    case "followLatest":
      context.follower.followLatest();
      return null;
    case "rescanSessions":
      context.rescan();
      return null;
    case "loadEarlier":
      return context.sendEarlier(message.beforeExchangeId) ? null : notFound("exchange");
    case "openOutput":
      host.showOutput();
      return null;
  }
}

async function done(work: Promise<void>): Promise<null> {
  await work;
  return null;
}

function isLinkedRecord(context: ActionContext, hash: string): boolean {
  return [...context.linked().values()].some((list) => list.some((d) => d.hash === hash));
}

function isLinkedNode(context: ActionContext, hash: string): boolean {
  return [...context.linked().values()].some((list) => list.some((d) => d.nodeHash === hash));
}

/** The file's absolute path, only if it is one of that exchange's "files changed" rows. */
function changedFile(context: ActionContext, exchangeId: string, shownPath: string): string | undefined {
  const exchange = context.session()?.exchange(exchangeId);
  if (!exchange) return undefined;
  const row = collectFileChanges(exchange).find((f) => displayPath(f.path, context.workspace) === shownPath);
  return row ? nativePath(row.path) : undefined;
}

async function chooseSession(context: ActionContext): Promise<PanelError | null> {
  const sessions = context.sessions();
  if (sessions.length === 0) return noSessionFound(context.host.isClaudeCodeInstalled());
  const current = context.follower.current()?.sessionId;
  const items = sessions.map((s) => ({
    sessionId: s.sessionId,
    label: s.sessionId === current ? `${shortId(s.sessionId)} (shown now)` : shortId(s.sessionId),
    detail: `Last active ${agoText(context.now() - s.modifiedAt)}`,
  }));
  const picked = await context.host.pickSession(items);
  if (picked && !context.follower.pin(picked)) return notFound("session");
  return null;
}

const SHORT_ID_CHARS = 8;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function shortId(sessionId: string): string {
  return `Session ${sessionId.slice(0, SHORT_ID_CHARS)}`;
}

function agoText(ms: number): string {
  if (ms < MINUTE_MS) return "just now";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

