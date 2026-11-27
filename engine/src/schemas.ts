/**
 * Checks input from outside TypeScript (a JSON file, a hand-edited config, another
 * process) against the contract. Callers that build ExtractionInput in TypeScript can
 * skip parseExtractionInput, but should still check parameter definitions they load.
 */
import { CODE_PLACEHOLDER, type ActiveDecision, type Author, type AuthorKind, type EngineTurn, type ExtractionInput, type ParameterDefinition } from "./contract";
import { InvalidInputError } from "./errors";

const AUTHOR_KINDS: readonly string[] = ["human", "ai"] satisfies AuthorKind[];

/** A fenced code block (``` or ~~~ at the start of a line): the one kind of code that is cheap to spot for sure. */
const CODE_FENCE = /(^|\n)[ \t]*(```|~~~)/;

/** Parameter ids are object keys and appear in the prompt, so keep them plain. */
const PARAMETER_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

export function parseExtractionInput(value: unknown): ExtractionInput {
  const input = record(value, "input");
  const turns = list(input.turns, "turns").map((t, i) => parseTurn(t, `turns[${i}]`));
  const activeDecisions = list(input.activeDecisions ?? [], "activeDecisions").map((d, i) => parseActive(d, `activeDecisions[${i}]`));
  requireUniqueIds(activeDecisions, "activeDecisions");
  return { turns, activeDecisions, parameters: parseParameterDefinitions(input.parameters ?? [], "parameters") };
}

/** Checks a list of parameter definitions, e.g. from a config file the project owner edits by hand. */
export function parseParameterDefinitions(value: unknown, where = "parameters"): ParameterDefinition[] {
  const parameters = list(value, where).map((p, i) => parseParameter(p, `${where}[${i}]`));
  requireUniqueIds(parameters, where);
  return parameters;
}

function parseParameter(value: unknown, where: string): ParameterDefinition {
  const parameter = record(value, where);
  const id = nonEmptyString(parameter.id, `${where}.id`);
  if (!PARAMETER_ID.test(id)) throw new InvalidInputError(`${where}.id: use a letter, then letters, digits or underscores`);
  return {
    id,
    name: text(parameter.name, `${where}.name`),
    low: text(parameter.low, `${where}.low`),
    high: text(parameter.high, `${where}.high`),
  };
}

function parseTurn(value: unknown, where: string): EngineTurn {
  const turn = record(value, where);
  return { id: nonEmptyString(turn.id, `${where}.id`), author: author(turn.author, `${where}.author`), text: codeFreeText(turn.text, `${where}.text`) };
}

function parseActive(value: unknown, where: string): ActiveDecision {
  const decision = record(value, where);
  return {
    id: nonEmptyString(decision.id, `${where}.id`),
    author: author(decision.author, `${where}.author`),
    decision: text(decision.decision, `${where}.decision`),
  };
}

function author(value: unknown, where: string): Author {
  const given = record(value, where);
  if (typeof given.kind !== "string" || !AUTHOR_KINDS.includes(given.kind)) throw new InvalidInputError(`${where}.kind: expected "human" or "ai"`);
  return { kind: given.kind as AuthorKind, name: text(given.name, `${where}.name`) };
}

/** Code must never reach the model. Full detection is the caller's job; this catches the obvious case. */
function codeFreeText(value: unknown, where: string): string {
  const message = string(value, where);
  if (CODE_FENCE.test(message)) throw new InvalidInputError(`${where}: contains a code block; replace code with ${CODE_PLACEHOLDER}`);
  return message;
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

/** Ids must match exactly what the caller sent, so they are returned untouched. */
function nonEmptyString(value: unknown, where: string): string {
  if (!string(value, where).trim()) throw new InvalidInputError(`${where}: must not be empty`);
  return value as string;
}

/** Names and descriptions: surrounding whitespace carries no meaning. */
function text(value: unknown, where: string): string {
  return nonEmptyString(value, where).trim();
}
