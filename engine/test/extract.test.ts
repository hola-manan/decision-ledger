/** The output guarantees from contract.ts and README.md, one test each, against a fake model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, CODE_PLACEHOLDER, EngineTurn, extractDecisions, ExtractionInput, Model, ModelOutputError } from "../src";
import { MAX_ACTIVE_DECISIONS_IN_PROMPT } from "../src/prompt";

/** A model that always gives `reply` and remembers the last prompt it saw. */
function fakeModel(reply: unknown) {
  const seen = { system: "", user: "", calls: 0 };
  const model: Model = async (system, user) => {
    Object.assign(seen, { system, user, calls: seen.calls + 1 });
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return { model, seen };
}

const turns: EngineTurn[] = [
  { id: "turn-a", author: "human", text: "Let's not support IE11 at all." },
  { id: "turn-b", author: "ai", text: "I'll use Vite for the build since it's faster." },
];
const input = (more: Partial<ExtractionInput> = {}): ExtractionInput => ({ turns, activeDecisions: [], ...more });

test("each decision is grounded to the input turn the model named, by position", async () => {
  const { model } = fakeModel({ decisions: [{ decision: "Build with Vite", turn: "2" }, { decision: "Drop IE11", turn: 1 }] });
  const out = await extractDecisions(input(), model);
  assert.deepEqual(out.map((d) => d.turnId), ["turn-b", "turn-a"]);
});

test("the author always follows the grounding turn, whatever the model says", async () => {
  const { model } = fakeModel({ decisions: [{ decision: "Build with Vite", turn: "2", author: "human" }] });
  const [out] = await extractDecisions(input(), model);
  assert.equal(out.author, "ai");
});

test("a quote is kept only if it appears verbatim in its turn, ignoring case and spacing", async () => {
  const { model } = fakeModel({
    decisions: [
      { decision: "Drop IE11", turn: "1", quote: "NOT support   IE11" },
      { decision: "Build with Vite", turn: "2", quote: "made up words" },
    ],
  });
  const out = await extractDecisions(input(), model);
  assert.equal(out[0].quote, "NOT support   IE11");
  assert.equal(out[1].quote, undefined);
});

test("supersedes maps the model's #number back to the caller's id; unknown numbers are dropped", async () => {
  const activeDecisions = [
    { id: "dec-1", author: "ai" as const, decision: "Use webpack" },
    { id: "dec-2", author: "human" as const, decision: "Support IE11" },
  ];
  const { model, seen } = fakeModel({
    decisions: [
      { decision: "Build with Vite", turn: "2", supersedes: "#1" },
      { decision: "Drop IE11", turn: "1", supersedes: 2 },
      { decision: "Something", turn: "1", supersedes: 9 },
    ],
  });
  const out = await extractDecisions(input({ activeDecisions }), model);
  assert.deepEqual(out.map((d) => d.supersedes), ["dec-1", "dec-2", undefined]);
  assert.match(seen.user, /#1 \(ai\) Use webpack\n#2 \(human\) Support IE11/);
});

test("only the most recent active decisions are sent; only those can be superseded", async () => {
  const total = MAX_ACTIVE_DECISIONS_IN_PROMPT + 5;
  const firstShown = total - MAX_ACTIVE_DECISIONS_IN_PROMPT + 1;
  const activeDecisions = Array.from({ length: total }, (_, i) => ({ id: `dec-${i + 1}`, author: "ai" as const, decision: `Decision ${i + 1}` }));
  const { model, seen } = fakeModel({
    decisions: [
      { decision: "Replace the newest", turn: "1", supersedes: total },
      { decision: "Replace the oldest shown", turn: "1", supersedes: firstShown },
      { decision: "Replace one never shown", turn: "1", supersedes: firstShown - 1 },
    ],
  });
  const out = await extractDecisions(input({ activeDecisions }), model);
  assert.deepEqual(out.map((d) => d.supersedes), [`dec-${total}`, `dec-${firstShown}`, undefined]);
  assert.ok(!seen.user.includes(`Decision ${firstShown - 1}\n`), "older decisions are left out");
  assert.ok(seen.user.includes(`#${firstShown} (ai) Decision ${firstShown}\n`));
});

test("caller ids are opaque: ids sharing a prefix are never confused", async () => {
  const similar: EngineTurn[] = [
    { id: "t10", author: "ai", text: "We'll cache in memory." },
    { id: "t1", author: "human", text: "Use Redis instead." },
  ];
  const { model, seen } = fakeModel({ decisions: [{ decision: "Use Redis", turn: "2" }] });
  const [out] = await extractDecisions({ turns: similar, activeDecisions: [] }, model);
  assert.equal(out.turnId, "t1");
  assert.ok(!seen.user.includes("t10"), "caller ids are not shown to the model");
});

test("decisions without text are skipped; text is trimmed", async () => {
  const { model } = fakeModel({ decisions: [{ decision: "  ", turn: "1" }, { turn: "1" }, null, { decision: " Drop IE11 ", turn: "1" }] });
  const out = await extractDecisions(input(), model);
  assert.deepEqual(out.map((d) => d.decision), ["Drop IE11"]);
});

test("JSON wrapped in prose or a code fence is still read; a bare array is accepted", async () => {
  const wrapped = await extractDecisions(input(), fakeModel('Sure:\n```json\n{"decisions":[{"decision":"Drop IE11","turn":"1"}]}\n```').model);
  const bare = await extractDecisions(input(), fakeModel('[{"decision":"Drop IE11","turn":"1"}]').model);
  assert.equal(wrapped.length, 1);
  assert.equal(bare.length, 1);
});

test("a reply that isn't JSON, or has no decisions list, throws ModelOutputError with a fixed message", async () => {
  const notJson = "I couldn't find any decisions in turn 2.";
  await assert.rejects(
    extractDecisions(input(), fakeModel(notJson).model),
    (e: Error) => e instanceof ModelOutputError && e.message === "Model reply is not JSON" && e.reply === notJson
  );
  await assert.rejects(
    extractDecisions(input(), fakeModel({ error: "overloaded" }).model),
    (e: Error) => e instanceof ModelOutputError && e.message === "Model reply has no decisions list"
  );
});

test("a quote that is only the code placeholder grounds nothing and is dropped", async () => {
  const withCode: EngineTurn = { id: "c", author: "ai", text: `Use the helper below.\n${CODE_PLACEHOLDER}` };
  const { model } = fakeModel({ decisions: [{ decision: "Use the helper", turn: "1", quote: CODE_PLACEHOLDER }] });
  const [out] = await extractDecisions({ turns: [withCode], activeDecisions: [] }, model);
  assert.equal(out.quote, undefined);
});

test("a reply with no decisions gives an empty list", async () => {
  assert.deepEqual(await extractDecisions(input(), fakeModel({ decisions: [] }).model), []);
});

test("turns that are only removed code are left out, and the model isn't called if nothing is left", async () => {
  const codeOnly: EngineTurn = { id: "code", author: "ai", text: `${CODE_PLACEHOLDER}\n${CODE_PLACEHOLDER}` };
  const silent = fakeModel({ decisions: [] });
  assert.deepEqual(await extractDecisions({ turns: [codeOnly], activeDecisions: [] }, silent.model), []);
  assert.equal(silent.seen.calls, 0);

  const mixed = fakeModel({ decisions: [{ decision: "Drop IE11", turn: "1" }] });
  const [out] = await extractDecisions({ turns: [codeOnly, turns[0]], activeDecisions: [] }, mixed.model);
  assert.equal(out.turnId, "turn-a", "numbering counts only the turns that were sent");
});

test("the prompt carries every turn, in order, with its author", async () => {
  const { model, seen } = fakeModel({ decisions: [] });
  await extractDecisions(input(), model);
  assert.match(seen.user, /<turn id="1" author="human">\nLet's not support IE11 at all.\n<\/turn>\n<turn id="2" author="ai">/);
  assert.match(seen.system, /Respond with ONLY JSON/);
});

test("model failures are thrown, not swallowed", async () => {
  const failing: Model = async () => {
    throw new ApiError("gemini", 429, "quota");
  };
  await assert.rejects(extractDecisions(input(), failing), (e: Error) => e instanceof ApiError && e.status === 429);
});
