import { Ledger, Author, LedgerNode } from "./store";
import { ChatTurn, Complete, extractDecisions, stripCode } from "./engine";

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
 * The full pipeline: store the (code-stripped) turns, extract grounded decisions,
 * and commit them as one new node. Returns the node hash, or null if no decisions.
 */
export async function ingest(
  ledger: Ledger,
  turns: IngestTurn[],
  complete: Complete,
  meta: IngestMeta
): Promise<{ node: string; records: string[] } | null> {
  const stored: ChatTurn[] = turns.map((t) => ({
    author: t.author,
    text: t.text,
    id: ledger.addTurn({
      author: t.author,
      text: stripCode(t.text),
      session: meta.session,
      origin: meta.origin,
      externalId: t.externalId,
      timestamp: t.timestamp ?? new Date().toISOString(),
    }),
  }));
  const active = ledger.activeAt();
  const decisions = await extractDecisions(stored, active, complete);
  if (!decisions.length) return null;
  const firstHuman = turns.find((t) => t.author === "human")?.text ?? turns[0]?.text ?? "";
  const summary = stripCode(firstHuman).replace(/\s+/g, " ").slice(0, 60);
  return ledger.commit(decisions, {
    message: meta.message ?? (summary || `${meta.origin} session`),
    origin: meta.origin,
    session: meta.session,
  });
}

export function shortHash(h: string): string {
  return h.slice(0, 7);
}

export function nodeLabel(n: LedgerNode): string {
  return `${n.message} (+${n.added.length})`;
}
