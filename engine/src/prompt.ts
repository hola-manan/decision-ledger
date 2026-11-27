/**
 * What the model is told. Turns and active decisions are labelled by position (1, 2, …),
 * not by the caller's ids, so ids can be any string; parse.ts maps labels back.
 */
import { GRADE_MAX, GRADE_MIN, type ActiveDecision, type Author, type EngineTurn, type ParameterDefinition } from "./contract";

/** Enough recent context to spot repeats and replacements without growing the prompt forever. */
export const MAX_ACTIVE_DECISIONS_IN_PROMPT = 40;

export const SYSTEM_PROMPT = `You extract DECISIONS from a conversation between people and AI coding agents.

A decision is a choice that shapes the work: what to build or not build, an approach, a technology, a constraint, a convention, a trade-off accepted, a scope change, a rejected alternative.
NOT decisions: greetings, status narration ("I read the file"), questions still open, explanations of how code works, restating earlier decisions with nothing new.

For each decision return:
- "decision": one short imperative-or-declarative sentence, specific (e.g. "Store sessions in Redis with a 24h TTL").
- "rationale": why, in one sentence, only if the conversation states it; else omit.
- "turn": the id of the turn that BROUGHT the decision (the person's request, or the AI's choice). If the AI proposed and a person only approved, use the AI turn unless the person changed it.
- "author": "human" or "ai" — whoever brought it, matching that turn.
- "quote": a short VERBATIM excerpt (max ~25 words) copied exactly from that turn that grounds it.
- "grades": for each parameter listed under PARAMETERS, its id mapped to a whole number from ${GRADE_MIN} to ${GRADE_MAX}, judged from the conversation using that parameter's scale. Omit a parameter you can't judge. Use {} if no parameters are listed.
- "supersedes": the #number of an earlier active decision this one reverses or replaces, else omit.

Be conservative: fewer, solid decisions beat many weak ones. Return [] if there are none.
Respond with ONLY JSON: {"decisions":[...]}`;

export function buildPrompt(turns: EngineTurn[], active: ActiveDecision[], parameters: ParameterDefinition[]): string {
  return parameterSection(parameters) + activeSection(active) + "NEW CONVERSATION:\n" + turns.map(turnBlock).join("\n");
}

/** Index of the oldest active decision shown to the model; older ones can't be referred to. */
export function firstShownActiveIndex(active: ActiveDecision[]): number {
  return Math.max(0, active.length - MAX_ACTIVE_DECISIONS_IN_PROMPT);
}

function parameterSection(parameters: ParameterDefinition[]): string {
  if (!parameters.length) return "";
  const lines = parameters.map((p) => `- ${p.id} (${p.name}): ${GRADE_MIN} = ${p.low}; ${GRADE_MAX} = ${p.high}`);
  return "PARAMETERS:\n" + lines.join("\n") + "\n\n";
}

function activeSection(active: ActiveDecision[]): string {
  if (!active.length) return "";
  const firstShown = firstShownActiveIndex(active);
  const lines = active.slice(firstShown).map((d, i) => `#${firstShown + i + 1} (${authorLabel(d.author)}) ${d.decision}`);
  return "ACTIVE DECISIONS SO FAR:\n" + lines.join("\n") + "\n\n";
}

function turnBlock(turn: EngineTurn, index: number): string {
  return `<turn id="${index + 1}" author="${turn.author.kind}" name="${attribute(turn.author.name)}">\n${turn.text}\n</turn>`;
}

const authorLabel = (author: Author) => `${author.kind}: ${oneLine(author.name)}`;

/** Names come from git config or model ids; keep them from breaking out of the attribute. */
const attribute = (value: string) => oneLine(value).replace(/["<>]/g, "'");

/** Control characters (newlines included) would let a name fake a new line of the prompt. */
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ");
