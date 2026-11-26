import type { Complete } from "./engine";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** Vertex AI express mode: a project-less endpoint authenticated by an API key alone. */
const VERTEX_EXPRESS_MODELS_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/";

/** AI Studio keys share the GEMINI_API_KEY name but are rejected by Vertex with these statuses. */
const AUTH_FAILURE_STATUSES = [401, 403];

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export function geminiComplete(apiKey: string, model: string): Complete {
  return async (system, user) => {
    // Key goes in a header, not the URL, so it can't leak into error messages or logs.
    const res = await fetch(`${VERTEX_EXPRESS_MODELS_URL}${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(apiErrorMessage(res.status, await res.text()));
    return responseText((await res.json()) as GenerateContentResponse);
  };
}

function apiErrorMessage(status: number, body: string): string {
  const hint = AUTH_FAILURE_STATUSES.includes(status)
    ? " (a Vertex AI express-mode key is required; AI Studio keys don't work here)"
    : "";
  return `Gemini API ${status}${hint}: ${body.slice(0, 300)}`;
}

/** Gemini answers 200 with no text when it blocks or stops early; say why instead of returning "". */
function responseText(body: GenerateContentResponse): string {
  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (text.trim()) return text;
  const reason = body.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no candidates";
  throw new Error(`Gemini returned no text (${reason})`);
}
