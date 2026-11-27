import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { InvalidInputError, parseExtractionInput } from "../src";

const EXAMPLE_FILE = path.join(__dirname, "..", "..", "examples", "conversation.json");

const rejects = (value: unknown, message: RegExp) =>
  assert.throws(() => parseExtractionInput(value), (e: Error) => e instanceof InvalidInputError && message.test(e.message));

test("the bundled example is valid input", () => {
  const input = parseExtractionInput(JSON.parse(fs.readFileSync(EXAMPLE_FILE, "utf8")));
  assert.equal(input.turns.length, 4);
  assert.equal(input.activeDecisions.length, 2);
});

test("activeDecisions may be left out", () => {
  assert.deepEqual(parseExtractionInput({ turns: [] }).activeDecisions, []);
});

test("extra fields are dropped, so nothing unexpected reaches the engine", () => {
  const input = parseExtractionInput({ turns: [{ id: "a", author: "ai", text: "x", secret: 1 }], extra: true });
  assert.deepEqual(input, { turns: [{ id: "a", author: "ai", text: "x" }], activeDecisions: [] });
});

test("bad input is rejected with the path of the bad field", () => {
  rejects(null, /^input: expected an object/);
  rejects({}, /^turns: expected an array/);
  rejects({ turns: [{ id: "a", author: "bot", text: "x" }] }, /^turns\[0\]\.author: expected "human" or "ai"/);
  rejects({ turns: [{ id: " ", author: "ai", text: "x" }] }, /^turns\[0\]\.id: must not be empty/);
  rejects({ turns: [{ id: "a", author: "ai" }] }, /^turns\[0\]\.text: expected a string/);
  rejects({ turns: [], activeDecisions: [{ id: "d", author: "ai", decision: "" }] }, /^activeDecisions\[0\]\.decision: must not be empty/);
});

test("active decision ids must be unique; turn ids may repeat (identical messages share an id)", () => {
  const turn = { id: "same", author: "ai", text: "x" };
  assert.equal(parseExtractionInput({ turns: [turn, turn] }).turns.length, 2);
  const decision = { id: "d", author: "ai", decision: "x" };
  rejects({ turns: [], activeDecisions: [decision, decision] }, /^activeDecisions: duplicate id "d"/);
});

test("text with a fenced code block is rejected, so code can't reach the model", () => {
  rejects({ turns: [{ id: "a", author: "ai", text: "Here:\n```js\nrun()\n```" }] }, /^turns\[0\]\.text: contains a code block/);
  rejects({ turns: [{ id: "a", author: "ai", text: "  ~~~\nx\n~~~" }] }, /contains a code block/);
  assert.doesNotThrow(() => parseExtractionInput({ turns: [{ id: "a", author: "ai", text: "Inline `code` is prose here." }] }));
});
