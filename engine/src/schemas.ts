/**
 * Checks input from outside TypeScript (a JSON file, another process) against the contract.
 * Callers that build ExtractionInput in TypeScript can skip this.
 */
import { CODE_PLACEHOLDER, type ActiveDecision, type Author, type EngineTurn, type ExtractionInput } from "./contract";
import { InvalidInputError } from "./errors";

const AUTHORS: readonly string[] = ["human", "ai"] satisfies Author[];

/** A fenced code block (``` or ~~~ at the start of a line): the one kind of code that is cheap to spot for sure. */
const CODE_FENCE = /(^|\n)[ \t]*(```|~~~)/;

export function parseExtractionInput(value: unknown): ExtractionInput {
  const input = record(value, "input");
  const turns = list(input.turns, "turns").map((t, i) => parseTurn(t, `turns[${i}]`));
  const activeDecisions = list(input.activeDecisions ?? [], "activeDecisions").map((d, i) => parseActive(d, `activeDecisions[${i}]`));
  requireUniqueIds(activeDecisions, "activeDecisions");
  return { turns, activeDecisions };
}

function parseTurn(value: unknown, where: string): EngineTurn {
  const turn = record(value, where);
  return { id: nonEmptyString(turn.id, `${where}.id`), author: author(turn.author, `${where}.author`), text: codeFreeText(turn.text, `${where}.text`) };
}

/** Code must never reach the model. Full detection is the caller's job; this catches the obvious case. */
function codeFreeText(value: unknown, where: string): string {
  const text = string(value, where);
  if (CODE_FENCE.test(text)) throw new InvalidInputError(`${where}: contains a code block; replace code with ${CODE_PLACEHOLDER}`);
  return text;
}

function parseActive(value: unknown, where: string): ActiveDecision {
  const decision = record(value, where);
  return {
    id: nonEmptyString(decision.id, `${where}.id`),
    author: author(decision.author, `${where}.author`),
    decision: nonEmptyString(decision.decision, `${where}.decision`),
  };
}

function requireUniqueIds(items: { id: string }[], where: string) {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) throw new InvalidInputError(`${where}: duplicate id "${id}"`);
    seen.add(id);
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidInputError(`${where}: expected an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidInputError(`${where}: expected an array`);
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string") throw new InvalidInputError(`${where}: expected a string`);
  return value;
}

function nonEmptyString(value: unknown, where: string): string {
  if (!string(value, where).trim()) throw new InvalidInputError(`${where}: must not be empty`);
  return value as string;
}

function author(value: unknown, where: string): Author {
  if (typeof value !== "string" || !AUTHORS.includes(value)) throw new InvalidInputError(`${where}: expected "human" or "ai"`);
  return value as Author;
}
