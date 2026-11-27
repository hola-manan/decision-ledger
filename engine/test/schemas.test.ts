import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { InvalidInputError, parseExtractionInput, parseParameterDefinitions } from "../src";

const EXAMPLE_FILE = path.join(__dirname, "..", "..", "examples", "conversation.json");

const ai = { kind: "ai", name: "claude-opus-5-5" };
const turn = (more: object = {}) => ({ id: "a", author: ai, text: "x", ...more });
const parameter = (more: object = {}) => ({ id: "reversibility", name: "Reversibility", low: "irreversible", high: "trivial to undo", ...more });

const rejects = (run: () => unknown, message: RegExp) =>
  assert.throws(run, (e: Error) => e instanceof InvalidInputError && message.test(e.message));
const rejectsInput = (value: unknown, message: RegExp) => rejects(() => parseExtractionInput(value), message);

test("the bundled example is valid input", () => {
  const input = parseExtractionInput(JSON.parse(fs.readFileSync(EXAMPLE_FILE, "utf8")));
  assert.equal(input.turns.length, 4);
  assert.equal(input.activeDecisions.length, 2);
  assert.deepEqual(input.parameters.map((p) => p.id), ["codeSpan", "reversibility"]);
});

test("activeDecisions and parameters may be left out", () => {
  const input = parseExtractionInput({ turns: [] });
  assert.deepEqual([input.activeDecisions, input.parameters], [[], []]);
});

test("extra fields are dropped, so nothing unexpected reaches the engine", () => {
  const input = parseExtractionInput({ turns: [turn({ secret: 1, author: { ...ai, email: "x" } })], extra: true });
  assert.deepEqual(input, { turns: [{ id: "a", author: ai, text: "x" }], activeDecisions: [], parameters: [] });
});

test("bad input is rejected with the path of the bad field", () => {
  rejectsInput(null, /^input: expected an object/);
  rejectsInput({}, /^turns: expected an array/);
  rejectsInput({ turns: [turn({ author: "ai" })] }, /^turns\[0\]\.author: expected an object/);
  rejectsInput({ turns: [turn({ author: { kind: "bot", name: "x" } })] }, /^turns\[0\]\.author\.kind: expected "human" or "ai"/);
  rejectsInput({ turns: [turn({ author: { kind: "human", name: " " } })] }, /^turns\[0\]\.author\.name: must not be empty/);
  rejectsInput({ turns: [turn({ id: " " })] }, /^turns\[0\]\.id: must not be empty/);
  rejectsInput({ turns: [turn({ text: undefined })] }, /^turns\[0\]\.text: expected a string/);
  rejectsInput({ turns: [], activeDecisions: [{ id: "d", author: ai, decision: "" }] }, /^activeDecisions\[0\]\.decision: must not be empty/);
});

test("ids come back exactly as sent; names and descriptions are trimmed", () => {
  const input = parseExtractionInput({ turns: [turn({ id: " t1 ", author: { kind: "ai", name: " claude " } })], parameters: [parameter({ name: " Risk " })] });
  assert.equal(input.turns[0].id, " t1 ");
  assert.equal(input.turns[0].author.name, "claude");
  assert.equal(input.parameters[0].name, "Risk");
});

test("active decision ids must be unique; turn ids may repeat (identical messages share an id)", () => {
  assert.equal(parseExtractionInput({ turns: [turn(), turn()] }).turns.length, 2);
  const decision = { id: "d", author: ai, decision: "x" };
  rejectsInput({ turns: [], activeDecisions: [decision, decision] }, /^activeDecisions: duplicate id "d"/);
});

test("text with a fenced code block is rejected, so code can't reach the model", () => {
  rejectsInput({ turns: [turn({ text: "Here:\n```js\nrun()\n```" })] }, /^turns\[0\]\.text: contains a code block/);
  rejectsInput({ turns: [turn({ text: "  ~~~\nx\n~~~" })] }, /contains a code block/);
  assert.doesNotThrow(() => parseExtractionInput({ turns: [turn({ text: "Inline `code` is prose here." })] }));
});

test("parameter definitions: every field is required, ids are plain and unique", () => {
  assert.deepEqual(parseParameterDefinitions([parameter()]), [parameter()]);
  rejects(() => parseParameterDefinitions({}), /^parameters: expected an array/);
  rejects(() => parseParameterDefinitions([parameter({ high: "" })]), /^parameters\[0\]\.high: must not be empty/);
  rejects(() => parseParameterDefinitions([parameter({ id: "code span" })]), /^parameters\[0\]\.id: use a letter, then letters, digits or underscores/);
  rejects(() => parseParameterDefinitions([parameter(), parameter()]), /^parameters: duplicate id "reversibility"/);
});

test("parameter errors can name the file they came from", () => {
  rejects(() => parseParameterDefinitions([parameter({ name: 3 })], "config.json parameters"), /^config\.json parameters\[0\]\.name: expected a string/);
});
