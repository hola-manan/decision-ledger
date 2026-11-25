import * as vscode from "vscode";
import type { Complete } from "./core/engine";
import { anthropicComplete } from "./core/anthropic";

export const SECRET_KEY = "ledger.anthropicApiKey";

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

/** Pick the engine's model: Anthropic key if set (or forced), otherwise a VS Code language model. */
export async function getEngine(ctx: vscode.ExtensionContext, preferred?: vscode.LanguageModelChat): Promise<Complete> {
  const cfg = vscode.workspace.getConfiguration("ledger");
  const provider = cfg.get<string>("engine.provider", "auto");
  const key = await ctx.secrets.get(SECRET_KEY);
  if (provider === "anthropic" || (provider === "auto" && key)) {
    if (!key) throw new Error("No Anthropic API key. Run 'Ledger: Set Anthropic API Key'.");
    return anthropicComplete(key, cfg.get<string>("engine.anthropicModel", "claude-haiku-5-5"));
  }
  const family = cfg.get<string>("engine.vscodeModelFamily", "");
  const models = await vscode.lm.selectChatModels(family ? { family } : {});
  const model = (!family && preferred) || models[0];
  if (!model) {
    throw new Error("No language model available. Install GitHub Copilot Chat or set an Anthropic API key ('Ledger: Set Anthropic API Key').");
  }
  return vscodeComplete(model);
}

export { collect };
