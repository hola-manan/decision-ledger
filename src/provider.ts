import * as vscode from "vscode";
import type { Complete } from "./core/engine";
import { anthropicComplete, DEFAULT_ANTHROPIC_MODEL } from "./core/anthropic";
import { DEFAULT_GEMINI_MODEL, geminiComplete } from "./core/gemini";
import { NoModelError } from "./core/errors";

export const SECRET_KEY = "ledger.anthropicApiKey";
export const GEMINI_SECRET_KEY = "ledger.geminiApiKey";

async function collect(resp: vscode.LanguageModelChatResponse, token?: vscode.CancellationToken): Promise<string> {
  let s = "";
  for await (const chunk of resp.text) {
    if (token?.isCancellationRequested) break;
    s += chunk;
  }
  return s;
}

export function vscodeComplete(model: vscode.LanguageModelChat): Complete {
  return async (system, user) => {
    const resp = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(system + "\n\n" + user)],
      { justification: "Decision Ledger extracts decisions from your chat to store them in .ledger/." },
      new vscode.CancellationTokenSource().token
    );
    return collect(resp);
  };
}

/**
 * Pick the engine's model: an API provider if forced or (in auto) if its key is set,
 * Anthropic first, then Gemini; otherwise a VS Code language model.
 */
export async function getEngine(ctx: vscode.ExtensionContext, preferred?: vscode.LanguageModelChat): Promise<Complete> {
  const cfg = vscode.workspace.getConfiguration("ledger");
  const provider = cfg.get<string>("engine.provider", "auto");
  const anthropicKey = await ctx.secrets.get(SECRET_KEY);
  if (provider === "anthropic" || (provider === "auto" && anthropicKey)) {
    if (!anthropicKey) throw new NoModelError("No Anthropic API key. Run 'Ledger: Set Anthropic API Key'.");
    return anthropicComplete(anthropicKey, cfg.get<string>("engine.anthropicModel", DEFAULT_ANTHROPIC_MODEL));
  }
  const geminiKey = await ctx.secrets.get(GEMINI_SECRET_KEY);
  if (provider === "gemini" || (provider === "auto" && geminiKey)) {
    if (!geminiKey) throw new NoModelError("No Gemini API key. Run 'Ledger: Set Vertex AI (Gemini) API Key'.");
    return geminiComplete(geminiKey, cfg.get<string>("engine.geminiModel", DEFAULT_GEMINI_MODEL));
  }
  const family = cfg.get<string>("engine.vscodeModelFamily", "");
  const models = await vscode.lm.selectChatModels(family ? { family } : {});
  const model = (!family && preferred) || models[0];
  if (!model) {
    throw new NoModelError("No language model available. Sign in to GitHub Copilot, or set an API key ('Ledger: Set Anthropic API Key' / 'Ledger: Set Vertex AI (Gemini) API Key').");
  }
  return vscodeComplete(model);
}

export { collect };
