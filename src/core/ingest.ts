import { Ledger, Author, LedgerNode, NewDecision } from "./store";
import { stripCode } from "./code";
import { ActiveDecision, EngineTurn, ExtractedDecision, extractDecisions, Model } from "../../engine/src";

export interface IngestTurn {
  author: Author;
  text: string;
  externalId?: string;
  timestamp?: string;
}

export interface IngestMeta {
  origin: string;
  session: string;
  message?: string;
}

/**
 * The full pipeline: store the turns with code removed, ask the engine for grounded
 * decisions, and commit them as one new node. Returns null if there were no decisions.
 * Every path into the ledger comes through here, so this is where code is kept from the model.
 */
export async function ingest(
  ledger: Ledger,
  turns: IngestTurn[],
  model: Model,
  meta: IngestMeta
): Promise<{ node: string; records: string[] } | null> {
  const engineTurns = turns.map((t) => storeTurn(ledger, t, meta));
  const decisions = await extractDecisions({ turns: engineTurns, activeDecisions: activeDecisions(ledger) }, model);
  if (!decisions.length) return null;
  return ledger.commit(decisions.map(toNewDecision), {
    message: meta.message ?? nodeMessage(turns, meta),
    origin: meta.origin,
    session: meta.session,
  });
}

function storeTurn(ledger: Ledger, turn: IngestTurn, meta: IngestMeta): EngineTurn {
  const text = stripCode(turn.text);
  const id = ledger.addTurn({
    author: turn.author,
    text,
    session: meta.session,
    origin: meta.origin,
    externalId: turn.externalId,
    timestamp: turn.timestamp ?? new Date().toISOString(),
  });
  return { id, author: turn.author, text };
}

function activeDecisions(ledger: Ledger): ActiveDecision[] {
  return ledger.activeAt().map(({ hash, record }) => ({ id: hash, author: record.author, decision: record.decision }));
}

function toNewDecision(d: ExtractedDecision): NewDecision {
  return { decision: d.decision, rationale: d.rationale, author: d.author, turn: d.turnId, quote: d.quote, supersedes: d.supersedes };
}

const MAX_NODE_MESSAGE_CHARS = 60;

function nodeMessage(turns: IngestTurn[], meta: IngestMeta): string {
  const firstHuman = turns.find((t) => t.author === "human")?.text ?? turns[0]?.text ?? "";
  const summary = stripCode(firstHuman).replace(/\s+/g, " ").slice(0, MAX_NODE_MESSAGE_CHARS);
  return summary || `${meta.origin} session`;
}

export function shortHash(h: string): string {
  return h.slice(0, 7);
}

export function nodeLabel(n: LedgerNode): string {
  return `${n.message} (+${n.added.length})`;
}
