/**
 * The panel's views from its current state: one exchange, the session line, the ledger
 * line, the badge. Pure: the orchestrator gathers the inputs.
 */
import { shortHash, type Ledger } from "../core";
import type { SessionFile } from "../claude-log";
import { SESSION_TITLE_MAX_CHARS, type ExchangeView, type LedgerView, type SessionView } from "../protocol";
import type { ExtractionStatus } from "../watcher";
import type { Exchange } from "./exchanges";
import { sectionState } from "./extraction";
import type { FollowedSession } from "./followed-session";
import type { FollowChoice } from "./follower";
import type { LinkedDecision } from "./linker";
import { deriveExchange, toDecisionSectionView, toExchangeView, type Derived } from "./view";

/** Other sessions count as active if they changed this recently. */
export const OTHER_SESSION_ACTIVE_MS = 30 * 60 * 1000;
const BADGE_TOOLTIPS = { certain: "Claude is asking you a question in Claude Code", likely: "Claude's reply ends with a question for you" };

export interface PanelState {
  session: FollowedSession;
  linked: Map<string, LinkedDecision[]>;
  status: ExtractionStatus;
  branch: string | null;
  now: number;
  humanName: string;
  workspace: string;
}

export function derivedOf(state: PanelState, exchange: Exchange): Derived {
  return deriveExchange(exchange, state.now, state.session.quietSince);
}

export function exchangeViewOf(state: PanelState, exchange: Exchange): ExchangeView {
  const derived = derivedOf(state, exchange);
  const linked = state.linked.get(exchange.id) ?? [];
  const decisions = toDecisionSectionView({
    state: sectionState({ exchange, phase: derived.phase, status: state.status }),
    linked,
    branch: state.branch,
    failure: state.status.failure,
  });
  return toExchangeView({ exchange, derived, decisions, humanName: state.humanName, workspace: state.workspace });
}

/** `file` is the followed session as the source knows it now (its size and time move on). */
export function sessionViewOf(session: FollowedSession, file: SessionFile, mode: FollowChoice["mode"], sessions: readonly SessionFile[], now: number): SessionView {
  const others = sessions.filter((s) => s.file !== file.file && now - s.modifiedAt < OTHER_SESSION_ACTIVE_MS);
  return {
    id: file.sessionId,
    title: titleOf(session.firstPrompt() ?? ""),
    lastActivityAt: new Date(file.modifiedAt).toISOString(),
    following: mode,
    otherActiveCount: others.length,
  };
}

export function ledgerViewOf(ledger: Ledger, extractionEnabled: boolean): LedgerView {
  const branch = ledger.currentBranch();
  const head = ledger.head();
  return { branch, detachedAt: !branch && head ? shortHash(head) : null, extractionEnabled };
}

/** Only waits the log shows for sure, or nearly: a "possible" permission wait never badges (D-007). */
export function badgeOf(state: PanelState): { count: number; tooltip: string } {
  let count = 0;
  let tooltip = "";
  for (const exchange of state.session.exchanges()) {
    const waiting = derivedOf(state, exchange).waiting;
    if (!waiting || waiting.confidence === "possible") continue;
    count++;
    tooltip ||= BADGE_TOOLTIPS[waiting.confidence];
  }
  return { count, tooltip };
}

/** The first prompt on one line, cut at SESSION_TITLE_MAX_CHARS. */
export function titleOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > SESSION_TITLE_MAX_CHARS ? `${line.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…` : line;
}
