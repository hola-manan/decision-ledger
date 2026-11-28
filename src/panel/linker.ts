/**
 * Which ledger records belong under which exchange (data-model.md §3). Reads the ledger,
 * never writes. Objects in .ledger/ are content-addressed and never change, so everything
 * known about a record is cached by its hash; only "which records are in the current
 * branch's state" is re-read each time.
 */
import { CLAUDE_CODE_ORIGIN, namedGrades, type DecisionRecord, type Ledger, type LedgerNode, type NamedGrade } from "../core";

export interface LinkedDecision {
  readonly hash: string;
  /** Shared with the cache: never change it. */
  readonly record: Readonly<DecisionRecord>;
  /** The node that added the record. */
  readonly nodeHash: string;
  readonly grades: readonly NamedGrade[];
  readonly replaces: { readonly hash: string; readonly seq: number; readonly decision: string; readonly authorName: string } | null;
}

/** What never changes about a record: its turn's identity, its grades, what it replaces. */
interface RecordFacts {
  record: DecisionRecord;
  origin: string;
  session: string;
  externalId: string | undefined;
  grades: NamedGrade[];
  replaces: LinkedDecision["replaces"];
}

export class DecisionLinker {
  private readonly facts = new Map<string, RecordFacts>();
  /**
   * Record hash → the node that added it. A record's hash covers its seq, source turn and
   * timestamp, so two nodes never add the same record; a branch inherits it from one node.
   */
  private readonly nodeOfRecord = new Map<string, string>();
  /** Every indexed node's ancestors are indexed too, so a walk can stop at the first one it meets. */
  private readonly indexedNodes = new Set<string>();

  constructor(private readonly ledger: () => Ledger) {}

  /**
   * Records in the current branch's state that came from this Claude Code session, grouped
   * by the exchange their turn falls in, in record order. `exchangeOf` maps a turn's
   * externalId (a log line uuid) to an exchange id. Throws if the ledger can't be read.
   */
  link(sessionId: string, exchangeOf: (externalId: string) => string | undefined): Map<string, LinkedDecision[]> {
    const ledger = this.ledger();
    const head = ledger.head(); // read once: another process may commit meanwhile
    if (!head) return new Map();
    this.indexNodesFrom(ledger, head);
    const byExchange = new Map<string, LinkedDecision[]>();
    for (const hash of ledger.get<LedgerNode>(head).state) {
      const facts = this.factsOf(ledger, hash);
      if (facts.origin !== CLAUDE_CODE_ORIGIN || facts.session !== sessionId || !facts.externalId) continue;
      const exchangeId = exchangeOf(facts.externalId);
      if (!exchangeId) continue;
      const list = byExchange.get(exchangeId) ?? [];
      list.push({ hash, record: facts.record, nodeHash: this.nodeOf(hash), grades: facts.grades, replaces: facts.replaces });
      byExchange.set(exchangeId, list);
    }
    return byExchange;
  }

  private nodeOf(recordHash: string): string {
    const node = this.nodeOfRecord.get(recordHash);
    if (!node) throw new Error(`Record ${recordHash} is in the current state but no node on this branch added it`);
    return node;
  }

  /**
   * Walks back from HEAD to the root or the first node already indexed, and only then adds
   * what it read: if a read fails midway, nothing is marked and the next call walks again.
   */
  private indexNodesFrom(ledger: Ledger, head: string): void {
    const walked: { hash: string; node: LedgerNode }[] = [];
    for (let hash: string | null = head; hash && !this.indexedNodes.has(hash); ) {
      const node: LedgerNode = ledger.get<LedgerNode>(hash);
      walked.push({ hash, node });
      hash = node.parent;
    }
    for (const { hash, node } of walked) {
      for (const recordHash of node.added) this.nodeOfRecord.set(recordHash, hash);
      this.indexedNodes.add(hash);
    }
  }

  private factsOf(ledger: Ledger, hash: string): RecordFacts {
    const cached = this.facts.get(hash);
    if (cached) return cached;
    const record = ledger.record(hash);
    const turn = ledger.turn(record.source.turn);
    const facts: RecordFacts = {
      record,
      origin: turn.origin,
      session: turn.session,
      externalId: turn.externalId,
      grades: namedGrades(ledger, record),
      replaces: record.supersedes ? replacedRecord(ledger, record.supersedes) : null,
    };
    this.facts.set(hash, facts);
    return facts;
  }
}

function replacedRecord(ledger: Ledger, hash: string): LinkedDecision["replaces"] {
  const old = ledger.record(hash);
  return { hash, seq: old.seq, decision: old.decision, authorName: old.author.name };
}
