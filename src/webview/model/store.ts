/**
 * The webview's state and the one function that changes it. No DOM, so it is tested in
 * Node. The webview keeps nothing else but UI state (open disclosures, scroll).
 */
import { PROTOCOL_VERSION, type ExchangeView, type HostMessage, type LedgerView, type PanelError, type SessionView } from "../../protocol/index.js";

export interface PanelStore {
  /** Nothing is shown until the first snapshot. */
  hasSnapshot: boolean;
  session: SessionView | null;
  ledger: LedgerView | null;
  problem: PanelError | null;
  /** Oldest first. */
  exchanges: ExchangeView[];
  hasEarlier: boolean;
  /** The last failed action's error, until the next snapshot. */
  actionError: PanelError | null;
  /** Ids of exchanges that changed in the last event, so only they are re-rendered. */
  changed: string[];
}

export type StoreEvent = { kind: "message"; message: HostMessage } | { kind: "versionMismatch"; received: number | null };

export const EMPTY_STORE: PanelStore = {
  hasSnapshot: false,
  session: null,
  ledger: null,
  problem: null,
  exchanges: [],
  hasEarlier: false,
  actionError: null,
  changed: [],
};

export function reduce(store: PanelStore, event: StoreEvent): PanelStore {
  if (event.kind === "versionMismatch") return { ...store, problem: versionMismatch(event.received), exchanges: [], changed: [] };
  const message = event.message;
  if (message.type === "snapshot") {
    const { session, ledger, problem, exchanges, hasEarlier } = message;
    return { hasSnapshot: true, session, ledger, problem, exchanges, hasEarlier, actionError: null, changed: exchanges.map((e) => e.id) };
  }
  if (!store.hasSnapshot) return store; // updates before the first snapshot can't be placed
  switch (message.type) {
    case "exchangeUpserted":
      return { ...store, exchanges: upsert(store.exchanges, message.exchange), changed: [message.exchange.id] };
    case "exchangesPrepended": {
      const known = new Set(store.exchanges.map((e) => e.id));
      const earlier = message.exchanges.filter((e) => !known.has(e.id));
      return { ...store, exchanges: [...earlier, ...store.exchanges], hasEarlier: message.hasEarlier, changed: earlier.map((e) => e.id) };
    }
    case "actionResult":
      return { ...store, actionError: message.ok ? null : message.error, changed: [] };
  }
}

/** Replaces the exchange with the same id in place, or adds it at the end. */
function upsert(exchanges: ExchangeView[], exchange: ExchangeView): ExchangeView[] {
  const index = exchanges.findIndex((e) => e.id === exchange.id);
  if (index < 0) return [...exchanges, exchange];
  const next = exchanges.slice();
  next[index] = exchange;
  return next;
}

/** Built here: the webview is the one that noticed. */
function versionMismatch(received: number | null): PanelError {
  return {
    code: "PROTOCOL_VERSION_MISMATCH",
    message: "The panel and the extension are different versions.",
    details: { received: received ?? "none", expected: PROTOCOL_VERSION },
    actions: [],
  };
}
