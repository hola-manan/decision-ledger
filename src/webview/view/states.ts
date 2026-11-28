/**
 * The panel's whole-panel states (build step 15): loading, a problem, no exchanges yet,
 * and the session line. Exchanges themselves are drawn by the session components.
 */
import type { LedgerView, PanelError, SessionView } from "../../protocol/index.js";
import type { ActionRequest } from "../bridge.js";
import { ACTION_LABELS, EMPTY_SESSION_TEXT, ERROR_TITLES, noSessionHint } from "../model/copy.js";
import { ago } from "../model/format.js";
import { button, element } from "./dom.js";

type Send = (action: ActionRequest) => void;

export function loadingView(): HTMLElement {
  return element("p", "status", "Loading the session…");
}

/** A problem that replaces the exchanges: its title, the extension's facts, and its buttons. */
export function problemView(problem: PanelError, send: Send, onReload: () => void): HTMLElement {
  const box = element("section", `empty-state${problem.code === "NO_SESSION_FOUND" ? "" : " empty-state-danger"}`);
  box.setAttribute("role", problem.code === "NO_SESSION_FOUND" ? "status" : "alert");
  box.append(element("h2", "empty-state-title", ERROR_TITLES[problem.code]));
  const installed = problem.details?.claudeCodeInstalled;
  box.append(element("p", "empty-state-body", problem.code === "NO_SESSION_FOUND" ? noSessionHint(installed !== false) : problem.message));
  const actions = element("div", "empty-state-actions");
  problem.actions.forEach((action, i) => actions.append(button(ACTION_LABELS[action], i === 0 ? "primary" : "secondary", () => send({ type: action }))));
  if (problem.code === "PROTOCOL_VERSION_MISMATCH") actions.append(button("Reload the panel", "primary", onReload));
  if (actions.childElementCount) box.append(actions);
  return box;
}

export function emptySessionView(ledger: LedgerView | null): HTMLElement {
  const box = element("section", "empty-state");
  box.append(element("h2", "empty-state-title", EMPTY_SESSION_TEXT.title), element("p", "empty-state-body", EMPTY_SESSION_TEXT.body));
  if (ledger) box.append(element("p", "empty-state-meta", ledgerLine(ledger)));
  return box;
}

/** "Following: {first prompt} · last active 2m ago", with Switch session / Follow latest. */
export function sessionLine(session: SessionView, now: number, send: Send): HTMLElement {
  const line = element("header", "session-line");
  const label = element("p", "session-title");
  label.append(element("span", "session-label", session.following === "pinned" ? "Pinned: " : "Following: "), element("span", "", session.title || "New conversation"));
  label.title = session.title;
  const meta = element("p", "session-meta", `Last active ${ago(now - Date.parse(session.lastActivityAt))}`);
  const actions = element("div", "session-actions");
  actions.append(button("Switch session", "text", () => send({ type: "chooseSession" })));
  if (session.following === "pinned") actions.append(button("Follow latest", "text", () => send({ type: "followLatest" })));
  line.append(label, meta, actions);
  if (session.otherActiveCount > 0) {
    const others = session.otherActiveCount === 1 ? "1 other active session" : `${session.otherActiveCount} other active sessions`;
    line.append(element("p", "session-meta", others));
  }
  return line;
}

export function ledgerLine(ledger: LedgerView): string {
  const where = ledger.branch ? `branch ${ledger.branch}` : `a detached node ${ledger.detachedAt ?? ""}`.trim();
  return ledger.extractionEnabled ? `Decisions are saved to the ledger on ${where}.` : "Agent watching is off. Decisions aren't being extracted.";
}
