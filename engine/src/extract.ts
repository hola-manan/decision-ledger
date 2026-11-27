import { CODE_PLACEHOLDER, ExtractedDecision, ExtractionInput, EngineTurn, Model } from "./contract";
import { buildPrompt, SYSTEM_PROMPT } from "./prompt";
import { parseModelOutput } from "./parse";

/**
 * The engine: conversation in, grounded decisions out, in the order the model gave them.
 * Turns with nothing but removed code are left out; if none remain the model isn't called.
 * Model and API failures are thrown, never swallowed.
 */
export async function extractDecisions(input: ExtractionInput, model: Model): Promise<ExtractedDecision[]> {
  const turns = input.turns.filter(hasProse);
  if (!turns.length) return [];
  const reply = await model(SYSTEM_PROMPT, buildPrompt(turns, input.activeDecisions, input.parameters));
  return parseModelOutput(reply, { turns, active: input.activeDecisions, parameters: input.parameters });
}

function hasProse(turn: EngineTurn): boolean {
  return turn.text.split(CODE_PLACEHOLDER).join("").trim() !== "";
}
