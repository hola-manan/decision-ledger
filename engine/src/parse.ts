/**
 * Reads the model's reply and enforces the output guarantees: every decision is grounded
 * to a real input turn, authorship follows that turn, quotes are verbatim, and
 * `supersedes` points at an active decision the model was shown, and grades are whole
 * numbers on the scale for the caller's parameters only. Nothing from the model
 * is trusted as is.
 */
import {
  CODE_PLACEHOLDER,
  GRADE_MAX,
  GRADE_MIN,
  type ActiveDecision,
  type EngineTurn,
  type ExtractedDecision,
  type Grades,
  type ParameterDefinition,
} from "./contract";
import { ModelOutputError } from "./errors";
import { firstShownActiveIndex } from "./prompt";

/** What the model is asked to return; every field may be missing or the wrong type. */
interface ModelDecision {
  decision?: unknown;
  rationale?: unknown;
  turn?: unknown;
  author?: unknown;
  quote?: unknown;
  grades?: unknown;
  supersedes?: unknown;
}

/** Everything the reply is checked against. */
interface ParseContext {
  turns: EngineTurn[];
  active: ActiveDecision[];
  parameters: ParameterDefinition[];
}

export function parseModelOutput(raw: string, context: ParseContext): ExtractedDecision[] {
  const out: ExtractedDecision[] = [];
  for (const item of decisionList(parseJson(raw), raw)) {
    const decision = toDecision(item, context);
    if (decision) out.push(decision);
  }
  return out;
}

function toDecision(item: ModelDecision, { turns, active, parameters }: ParseContext): ExtractedDecision | undefined {
  if (typeof item.decision !== "string" || !item.decision.trim()) return undefined;
  const turn = groundingTurn(item, turns);
  if (!turn) return undefined;
  const result: ExtractedDecision = {
    decision: item.decision.trim(),
    turnId: turn.id,
    author: { ...turn.author },
    grades: validGrades(item.grades, parameters),
  };
  if (typeof item.rationale === "string" && item.rationale.trim()) result.rationale = item.rationale.trim();
  const quote = verbatimQuote(item.quote, turn);
  if (quote) result.quote = quote;
  const supersedes = supersededDecision(item.supersedes, active);
  if (supersedes) result.supersedes = supersedes.id;
  return result;
}

/**
 * The turn the model named. If it named none we can find, fall back to the first turn by
 * the same author, then the last turn: a weak guess, listed as a known issue in README.md.
 */
function groundingTurn(item: ModelDecision, turns: EngineTurn[]): EngineTurn | undefined {
  return turns[label(item.turn) - 1] ?? turns.find((t) => t.author.kind === item.author) ?? turns[turns.length - 1];
}

/** Only decisions the model was shown can be replaced, so a made-up number can't retire an old one. */
function supersededDecision(value: unknown, active: ActiveDecision[]): ActiveDecision | undefined {
  const index = label(value) - 1;
  return index >= firstShownActiveIndex(active) ? active[index] : undefined;
}

/** Keeps grades for known parameters that are whole numbers on the scale; drops the rest. */
function validGrades(value: unknown, parameters: ParameterDefinition[]): Grades {
  const given = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const grades: Grades = {};
  for (const { id } of parameters) {
    const grade = label(given[id]);
    if (Number.isInteger(grade) && grade >= GRADE_MIN && grade <= GRADE_MAX) grades[id] = grade;
  }
  return grades;
}

/** A number the model gave: a position label ("3", 3 or "#3") or a grade; NaN if it isn't one. Lenient, as models vary. */
function label(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const digits = value.trim().replace(/^#/, "");
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
}

function verbatimQuote(quote: unknown, turn: EngineTurn): string | undefined {
  if (typeof quote !== "string") return undefined;
  const wanted = normalize(quote);
  const groundsNothing = !wanted || wanted === normalize(CODE_PLACEHOLDER);
  return !groundsNothing && normalize(turn.text).includes(wanted) ? quote.trim() : undefined;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Accepts {"decisions":[...]} or a bare [...]; anything else is a failed reply, not "no decisions". */
function decisionList(data: unknown, raw: string): ModelDecision[] {
  const list = Array.isArray(data) ? data : (data as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list)) throw new ModelOutputError("Model reply has no decisions list", raw);
  return list.filter((d): d is ModelDecision => typeof d === "object" && d !== null);
}

/** Models sometimes wrap the JSON in prose or a code fence; take the JSON out. */
function parseJson(raw: string): unknown {
  const fromFirstBracket = raw.replace(/^[\s\S]*?(?=[{[])/, "").replace(/```[\s\S]*$/, "");
  const outerObject = raw.match(/\{[\s\S]*\}/)?.[0];
  for (const candidate of [fromFirstBracket, outerObject]) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }
  throw new ModelOutputError("Model reply is not JSON", raw);
}

function tryParseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
