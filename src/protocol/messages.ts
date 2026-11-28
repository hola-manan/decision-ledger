/** Every message between the extension and the panel webview (api.md §1). */
import type { PanelError } from "./errors.js";
import type { ExchangeView, LedgerView, SessionView } from "./views.js";

/** The latest exchanges sent in a snapshot; earlier ones come on request. */
export const MAX_SNAPSHOT_EXCHANGES = 30;
export const SESSION_TITLE_MAX_CHARS = 60;

interface Envelope {
  v: number;
}

// ---------- host → webview ----------

export interface SnapshotMessage extends Envelope {
  type: "snapshot";
  /** Null with the problem NO_SESSION_FOUND. */
  session: SessionView | null;
  /** Oldest first. */
  exchanges: ExchangeView[];
  hasEarlier: boolean;
  ledger: LedgerView;
  /** Panel-level problems only. */
  problem: PanelError | null;
}

export interface ExchangeUpsertedMessage extends Envelope {
  type: "exchangeUpserted";
  /** The whole exchange, replacing any with the same id. */
  exchange: ExchangeView;
}

export interface ExchangesPrependedMessage extends Envelope {
  type: "exchangesPrepended";
  exchanges: ExchangeView[];
  hasEarlier: boolean;
}

export interface ActionResultMessage extends Envelope {
  type: "actionResult";
  requestId: string;
  ok: boolean;
  error: PanelError | null;
}

export type HostMessage = SnapshotMessage | ExchangeUpsertedMessage | ExchangesPrependedMessage | ActionResultMessage;

// ---------- webview → host ----------

/** Actions with no payload beyond requestId; each gets one actionResult. */
export const SIMPLE_ACTIONS = [
  "retryExtraction",
  "setUpModel",
  "editParameters",
  "enableExtraction",
  "chooseSession",
  "followLatest",
  "rescanSessions",
  "openOutput",
] as const;
export type SimpleActionType = (typeof SIMPLE_ACTIONS)[number];

interface Action extends Envelope {
  requestId: string;
}

export type WebviewMessage =
  | (Envelope & { type: "ready" })
  | (Action & { type: SimpleActionType })
  | (Action & { type: "openRecord"; recordId: string })
  | (Action & { type: "revealNode"; nodeId: string })
  | (Action & { type: "openFile"; exchangeId: string; path: string })
  | (Action & { type: "loadEarlier"; beforeExchangeId: string })
  /** Logged by the host; no reply. */
  | (Envelope & { type: "protocolError"; receivedType: string | null; reason: string })
  /** The host re-renders the webview; no reply. */
  | (Envelope & { type: "reloadRequest" });

/** Reserved for "save a missed sentence as a decision" (D-016): rejected until it is built. */
export const RESERVED_WEBVIEW_TYPES: readonly string[] = ["saveDecision"];
