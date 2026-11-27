import type { Model } from "../contract";
import { ApiError, ModelOutputError } from "../errors";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_REPLY_TOKENS = 2048;
const MAX_ERROR_BODY_CHARS = 300;

export function anthropicModel(apiKey: string, modelName: string): Model {
  return async (system, user) => {
    const res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION },
      body: JSON.stringify({ model: modelName, max_tokens: MAX_REPLY_TOKENS, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new ApiError("anthropic", res.status, `Anthropic API ${res.status}: ${(await res.text()).slice(0, MAX_ERROR_BODY_CHARS)}`);
    const body = (await res.json()) as MessagesResponse;
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text.trim()) throw new ModelOutputError(`Anthropic returned no text (${body.stop_reason ?? "no content"})`);
    return text;
  };
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
}
