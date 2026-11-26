import type { Complete } from "./engine";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

export function anthropicComplete(apiKey: string, model: string): Complete {
  return async (system, user) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { content: { type: string; text?: string }[] };
    return body.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  };
}
