import { Ledger, Author, AuthorKind, LedgerNode, NewDecision } from "./store";
import { stripCode } from "./code";
import { loadParameters } from "./parameters";
import { UNKNOWN_AI_NAME } from "./identity";
import { ActiveDecision, EngineTurn, ExtractedDecision, extractDecisions, InvalidInputError, Model } from "../../engine/src";

export interface IngestTurn {
  author: AuthorKind;
  /** Who wrote it: a person's name or a model name. Defaults to meta.humanName, or "ai". */
  name?: string;
  text: string;
  externalId?: string;
  timestamp?: string;
}

export interface IngestMeta {
  origin: string;
  session: string;
  /** Name for human turns that don't carry one (see core/identity). */
  humanName: string;
  message?: string;
}

/**
 * The full pipeline: store the turns with code removed, ask the engine for grounded and
 * graded decisions, and commit them as one new node. Returns null if there were none.
 * Every path into the ledger comes through here, so this is where code is kept from the model.
 */
export async function ingest(
  ledger: Ledger,
  turns: IngestTurn[],
  model: Model,
  meta: IngestMeta
): Promise<{ node: string; records: string[] } | null> {
  const parameters = loadParameters(ledger);
  const engineTurns = turns.map((t) => storeTurn(ledger, t, meta));
  const decisions = await extractDecisions({ turns: engineTurns, activeDecisions: activeDecisions(ledger), parameters }, model);
  if (!decisions.length) return null;
  const parameterSet = ledger.addParameterSet(parameters);
  return ledger.commit(
    decisions.map((d) => toNewDecision(d, parameterSet)),
    { message: meta.message ?? nodeMessage(turns, meta), origin: meta.origin, session: meta.session }
  );
}

function storeTurn(ledger: Ledger, turn: IngestTurn, meta: IngestMeta): EngineTurn {
  const text = stripCode(turn.text);
  const author = authorOf(turn, meta);
  const id = ledger.addTurn({
    author,
    text,
    session: meta.session,
    origin: meta.origin,
    externalId: turn.externalId,
    timestamp: turn.timestamp ?? new Date().toISOString(),
  });
  return { id, author, text };
}

/** Names come from git config, logs or CLI input; they are cleaned once here, so storage, prompt and UI all agree. */
function authorOf(turn: IngestTurn, meta: IngestMeta): Author {
  const fallback = turn.author === "human" ? meta.humanName : UNKNOWN_AI_NAME;
  return { kind: turn.author, name: cleanName(turn.name ?? "") || cleanName(fallback) || turn.author };
}

/** One line, no control characters or table-breaking pipes, single spaces. */
function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f|]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Checks turns from outside TypeScript (the `ledger ingest` command). Authors use the
 * engine's shape, { kind, name }, with the name optional.
 */
export function parseIngestTurns(value: unknown): IngestTurn[] {
  if (!Array.isArray(value)) throw new InvalidInputError("turns: expected an array");
  return value.map((turn, i) => parseIngestTurn(turn, `turns[${i}]`));
}

function parseIngestTurn(value: unknown, where: string): IngestTurn {
  if (typeof value !== "object" || value === null) throw new InvalidInputError(`${where}: expected an object`);
  const { author, text } = value as { author?: { kind?: unknown; name?: unknown }; text?: unknown };
  if (author?.kind !== "human" && author?.kind !== "ai") throw new InvalidInputError(`${where}.author.kind: expected "human" or "ai"`);
  if (author.name !== undefined && typeof author.name !== "string") throw new InvalidInputError(`${where}.author.name: expected a string`);
  if (typeof text !== "string") throw new InvalidInputError(`${where}.text: expected a string`);
  return { author: author.kind, name: author.name, text };
}

function activeDecisions(ledger: Ledger): ActiveDecision[] {
  return ledger.activeAt().map(({ hash, record }) => ({ id: hash, author: record.author, decision: record.decision }));
}

function toNewDecision(d: ExtractedDecision, parameterSet: string): NewDecision {
  return {
    decision: d.decision,
    rationale: d.rationale,
    source: { turn: d.turnId, quote: d.quote },
    grades: d.grades,
    parameterSet,
    author: d.author,
    supersedes: d.supersedes,
  };
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
