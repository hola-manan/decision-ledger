/** The only place the engine reads environment variables. */
import type { Model } from "./contract";
import { NoModelError } from "./errors";
import { anthropicModel, DEFAULT_ANTHROPIC_MODEL } from "./models/anthropic";
import { DEFAULT_GEMINI_MODEL, geminiModel } from "./models/gemini";

export interface ModelEnv {
  ANTHROPIC_API_KEY?: string;
  /** A Vertex AI express-mode key. */
  GEMINI_API_KEY?: string;
  /** Overrides the chosen provider's default model. */
  LEDGER_MODEL?: string;
}

/** Anthropic wins if both keys are set. */
export function modelFromEnv(env: ModelEnv = process.env): Model {
  if (env.ANTHROPIC_API_KEY) return anthropicModel(env.ANTHROPIC_API_KEY, env.LEDGER_MODEL || DEFAULT_ANTHROPIC_MODEL);
  if (env.GEMINI_API_KEY) return geminiModel(env.GEMINI_API_KEY, env.LEDGER_MODEL || DEFAULT_GEMINI_MODEL);
  throw new NoModelError("Set ANTHROPIC_API_KEY or GEMINI_API_KEY (a Vertex AI express-mode key)");
}
