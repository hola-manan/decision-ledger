/**
 * Reads the model's reply and enforces the output guarantees: every decision is grounded
 * to a real input turn, authorship follows that turn, quotes are verbatim, and
 * `supersedes` points at an active decision the model was shown. Nothing from the model
 * is trusted as is.
 */
import { CODE_PLACEHOLDER, type ActiveDecision, type EngineTurn, type ExtractedDecision } from "./contract";
import { ModelOutputError } from "./errors";
import { firstShownActiveIndex } from "./prompt";

/** What the model is asked to return; every field may be missing or the wrong type. */
interface ModelDecision {
  decision?: unknown;
  rationale?: unknown;
  turn?: unknown;
  author?: unknown;
  quote?: unknown;
  supersedes?: unknown;
}

export function parseModelOutput(raw: string, turns: EngineTurn[], active: ActiveDecision[]): ExtractedDecision[] {
  const out: ExtractedDecision[] = [];
  for (const item of decisionList(parseJson(raw), raw)) {
    const decision = toDecision(item, turns, active);
    if (decision) out.push(decision);
  }
  return out;
}

function toDecision(item: ModelDecision, turns: EngineTurn[], active: ActiveDecision[]): ExtractedDecision | undefined {
  if (typeof item.decision !== "string" || !item.decision.trim()) return undefined;
  const turn = groundingTurn(item, turns);
  if (!turn) return undefined;
  const result: ExtractedDecision = { decision: item.decision.trim(), turnId: turn.id, author: turn.author };
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
  return turns[label(item.turn) - 1] ?? turns.find((t) => t.author === item.author) ?? turns[turns.length - 1];
}

/** Only decisions the model was shown can be replaced, so a made-up number can't retire an old one. */
function supersededDecision(value: unknown, active: ActiveDecision[]): ActiveDecision | undefined {
  const index = label(value) - 1;
  return index >= firstShownActiveIndex(active) ? active[index] : undefined;
}

/** A position label from the prompt ("3", 3 or "#3") as a number; NaN if it isn't one. Lenient, as models vary. */
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
