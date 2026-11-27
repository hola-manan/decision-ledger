/**
 * The shapes of everything stored in .ledger/objects, and how objects written by older
 * versions read as today's shapes. Stored objects are never rewritten (their hash is
 * their identity), so old ones are upgraded as they are read.
 */
import type { Author, AuthorKind, Grades, ParameterDefinition } from "../../engine/src";

export type { Author, AuthorKind, Grades, ParameterDefinition };

/** One chat message with code stripped. Records are grounded to it. */
export interface Turn {
  type: "turn";
  author: Author;
  text: string;
  session: string;
  origin: string; // e.g. "vscode-chat", "claude-code"
  externalId?: string;
  timestamp: string;
}

/** Where a decision came from: the message that brought it, and the words in it that ground it. */
export interface Source {
  turn: string; // hash of the Turn
  quote?: string; // verbatim excerpt of that turn
}

/** The project owner's parameter set at the time a record was graded. */
export interface ParameterSet {
  type: "parameters";
  parameters: ParameterDefinition[];
}

/** One decision. */
export interface DecisionRecord {
  type: "record";
  seq: number; // order along a branch's history
  decision: string;
  rationale?: string;
  source: Source;
  /** Parameter id → grade (1–5), against the parameter set below. Empty if none were given. */
  grades: Grades;
  /** Hash of the ParameterSet the grades refer to; absent on records from before grading existed. */
  parameterSet?: string;
  author: Author;
  supersedes?: string; // hash of an earlier record this one replaces
  timestamp: string;
}

/** A snapshot of the database state, like a git commit. */
export interface LedgerNode {
  type: "node";
  parent: string | null;
  message: string;
  origin: string;
  session?: string;
  added: string[]; // record hashes added in this node, in order
  state: string[]; // every record hash in the db at this node, in order
  timestamp: string;
}

export type LedgerObject = Turn | DecisionRecord | LedgerNode | ParameterSet;

/** What a caller hands the store to commit; the store adds type, seq and timestamp. */
export type NewDecision = Omit<DecisionRecord, "type" | "seq" | "timestamp">;

/** v0.1 stored the author as a bare "human" | "ai", with no name. */
type LegacyAuthor = AuthorKind;

/** v0.1 records: author as a bare kind, `turn` and `quote` at the top level, no grades. */
interface LegacyRecord extends Omit<DecisionRecord, "author" | "source" | "grades"> {
  author: LegacyAuthor;
  turn: string;
  quote?: string;
}

export function upgradeRecord(stored: DecisionRecord | LegacyRecord): DecisionRecord {
  if (!isLegacyRecord(stored)) return stored;
  const { turn, quote, author, ...rest } = stored;
  return { ...rest, author: upgradeAuthor(author), source: { turn, quote }, grades: {} };
}

export function upgradeTurn(stored: Turn | (Omit<Turn, "author"> & { author: LegacyAuthor })): Turn {
  return typeof stored.author === "string" ? { ...stored, author: upgradeAuthor(stored.author) } : (stored as Turn);
}

/** v0.1 didn't record names, so the kind stands in for one. */
function upgradeAuthor(kind: LegacyAuthor): Author {
  return { kind, name: kind };
}

function isLegacyRecord(stored: DecisionRecord | LegacyRecord): stored is LegacyRecord {
  return typeof stored.author === "string";
}
