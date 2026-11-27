import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicModel, ApiError, geminiModel, modelFromEnv, ModelOutputError, NoModelError } from "../src";

/** Replaces fetch for one test, recording each request. */
async function withFetch(respond: () => Response, run: (requests: { url: string; init: RequestInit }[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return respond();
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const geminiReply = (text: string) => () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
const anthropicReply = (text: string) => () => new Response(JSON.stringify({ content: [{ type: "text", text }] }));

test("gemini: sends system + user to Vertex express with the key in a header, returns the text", async () => {
  const splitIntoParts = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"decisions":' }, { text: "[]}" }] } }] }));
  await withFetch(splitIntoParts, async (requests) => {
    const text = await geminiModel("KEY123", "gemini-3.8-flash")("SYS", "USER");
    assert.equal(text, '{"decisions":[]}');
    const [sent] = requests;
    assert.equal(sent.url, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent");
    assert.ok(!sent.url.includes("KEY123"));
    assert.equal(new Headers(sent.init.headers).get("x-goog-api-key"), "KEY123");
    const body = JSON.parse(String(sent.init.body));
    assert.equal(body.systemInstruction.parts[0].text, "SYS");
    assert.equal(body.contents[0].parts[0].text, "USER");
  });
});

test("gemini: API errors are ApiError with the status", async () => {
  await withFetch(
    () => new Response("quota exceeded", { status: 429 }),
    () => assert.rejects(geminiModel("k", "m")("s", "u"), (e: Error) => e instanceof ApiError && e.provider === "gemini" && e.status === 429)
  );
});

test("gemini: a blocked or empty answer is a ModelOutputError that says why", async () => {
  const noText = (reason: string) => (e: Error) => e instanceof ModelOutputError && e.message === `Gemini returned no text (${reason})`;
  await withFetch(
    () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })),
    () => assert.rejects(geminiModel("k", "m")("s", "u"), noText("SAFETY"))
  );
  await withFetch(
    () => new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] })),
    () => assert.rejects(geminiModel("k", "m")("s", "u"), noText("MAX_TOKENS"))
  );
});

test("anthropic: sends the key in a header and returns the text; API errors and empty answers are typed", async () => {
  await withFetch(anthropicReply("hi"), async (requests) => {
    assert.equal(await anthropicModel("KEY123", "m")("SYS", "USER"), "hi");
    const [sent] = requests;
    assert.equal(new Headers(sent.init.headers).get("x-api-key"), "KEY123");
    const body = JSON.parse(String(sent.init.body));
    assert.deepEqual([body.system, body.messages[0].content], ["SYS", "USER"]);
  });
  await withFetch(
    () => new Response("overloaded", { status: 529 }),
    () => assert.rejects(anthropicModel("k", "m")("s", "u"), (e: Error) => e instanceof ApiError && e.provider === "anthropic" && e.status === 529)
  );
  await withFetch(
    () => new Response(JSON.stringify({ content: [], stop_reason: "max_tokens" })),
    () => assert.rejects(anthropicModel("k", "m")("s", "u"), (e: Error) => e instanceof ModelOutputError && /no text \(max_tokens\)/.test(e.message))
  );
});

test("modelFromEnv: Anthropic wins over Gemini, LEDGER_MODEL overrides the model", async () => {
  await withFetch(anthropicReply("hi"), async (requests) => {
    const reply = await modelFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", LEDGER_MODEL: "custom" })("s", "u");
    assert.equal(reply, "hi");
    assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(JSON.parse(String(requests[0].init.body)).model, "custom");
  });
});

test("modelFromEnv: Gemini when it's the only key; no key throws NoModelError", async () => {
  await withFetch(geminiReply("hi"), async (requests) => {
    await modelFromEnv({ GEMINI_API_KEY: "g" })("s", "u");
    assert.match(requests[0].url, /gemini-3\.8-flash:generateContent$/);
  });
  assert.throws(() => modelFromEnv({}), NoModelError);
});
