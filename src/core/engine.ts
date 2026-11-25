/**
 * The engine: chat in, grounded decisions out. Code is never sent for processing.
 */
import type { Author, DecisionRecord, NewDecision } from "./store";

export interface ChatTurn {
  /** Hash of the stored Turn object — what records are grounded to. */
  id: string;
  author: Author;
  text: string;
}

/** Anything that can answer a prompt with text. */
export type Complete = (system: string, user: string) => Promise<string>;

const FENCE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)/g;

/** Remove fenced code blocks. "We trust you over there." */
export function stripCode(text: string): string {
  return text.replace(FENCE, "$1[code omitted]").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split text into prose and code segments, keeping code verbatim. */
export function splitCode(text: string): { kind: "prose" | "code"; text: string }[] {
  const out: { kind: "prose" | "code"; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const start = m.index! + m[1].length;
    if (start > last) out.push({ kind: "prose", text: text.slice(last, start) });
    out.push({ kind: "code", text: text.slice(start, m.index! + m[0].length) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: "prose", text: text.slice(last) });
  return out.filter((s) => s.text.trim());
}

export const SYSTEM_PROMPT = `You extract DECISIONS from a conversation between a human and an AI coding agent.

A decision is a choice that shapes the work: what to build or not build, an approach, a technology, a constraint, a convention, a trade-off accepted, a scope change, a rejected alternative.
NOT decisions: greetings, status narration ("I read the file"), questions still open, explanations of how code works, restating earlier decisions with nothing new.

For each decision return:
- "decision": one short imperative-or-declarative sentence, specific (e.g. "Store sessions in Redis with a 24h TTL").
- "rationale": why, in one sentence, only if the conversation states it; else omit.
- "turn": the id of the turn that BROUGHT the decision (the human's request, or the AI's choice). If the AI proposed and the human only approved, use the AI turn and author "ai" unless the human changed it.
- "author": "human" or "ai" — whoever brought it, matching that turn.
- "quote": a short VERBATIM excerpt (max ~25 words) copied exactly from that turn that grounds it.
- "supersedes": the #number of an earlier active decision this one reverses or replaces, else omit.

Be conservative: fewer, solid decisions beat many weak ones. Return [] if there are none.
Respond with ONLY JSON: {"decisions":[...]}`;

export function buildPrompt(turns: ChatTurn[], active: DecisionRecord[]): string {
  const ctx = active.length
    ? "ACTIVE DECISIONS SO FAR:\n" + active.slice(-40).map((r) => `#${r.seq} (${r.author}) ${r.decision}`).join("\n") + "\n\n"
    : "";
  const conv = turns
    .map((t) => `<turn id="${t.id.slice(0, 10)}" author="${t.author}">\n${stripCode(t.text)}\n</turn>`)
    .join("\n");
  return `${ctx}NEW CONVERSATION:\n${conv}`;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function parseJson(raw: string): unknown {
  const cleaned = raw.replace(/^[\s\S]*?(?=[{[])/, "").replace(/```[\s\S]*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Engine returned non-JSON output");
  }
}

/** Validate model output and ground every decision to a real turn. */
export function parseDecisions(
  raw: string,
  turns: ChatTurn[],
  active: { hash: string; record: DecisionRecord }[]
): NewDecision[] {
  const data = parseJson(raw) as { decisions?: unknown } | unknown[];
  const list = Array.isArray(data) ? data : Array.isArray((data as any)?.decisions) ? (data as any).decisions : [];
  const bySeq = new Map(active.map((a) => [a.record.seq, a.hash]));
  const out: NewDecision[] = [];
  for (const d of list as any[]) {
    if (!d || typeof d.decision !== "string" || !d.decision.trim()) continue;
    const tid = String(d.turn ?? "");
    const turn =
      turns.find((t) => tid && t.id.startsWith(tid)) ??
      turns.find((t) => t.author === d.author) ??
      turns[turns.length - 1];
    if (!turn) continue;
    let quote: string | undefined = typeof d.quote === "string" ? d.quote.trim() : undefined;
    // Grounding check: keep the quote only if it really appears in that turn.
    if (quote && !norm(stripCode(turn.text)).includes(norm(quote))) quote = undefined;
    const sup = typeof d.supersedes === "number" ? d.supersedes : parseInt(String(d.supersedes ?? "").replace("#", ""), 10);
    out.push({
      decision: d.decision,
      rationale: typeof d.rationale === "string" ? d.rationale : undefined,
      author: turn.author, // authorship follows the grounding turn
      turn: turn.id,
      quote,
      supersedes: Number.isFinite(sup) ? bySeq.get(sup) : undefined,
    });
  }
  return out;
}

export async function extractDecisions(
  turns: ChatTurn[],
  active: { hash: string; record: DecisionRecord }[],
  complete: Complete
): Promise<NewDecision[]> {
  const meaningful = turns.filter((t) => stripCode(t.text).replace(/\[code omitted\]/g, "").trim());
  if (!meaningful.length) return [];
  const raw = await complete(SYSTEM_PROMPT, buildPrompt(meaningful, active.map((a) => a.record)));
  return parseDecisions(raw, meaningful, active);
}
