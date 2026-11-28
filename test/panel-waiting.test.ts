import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWaiting, PERMISSION_QUIET_MS } from "../src/panel/waiting";
import { STALE_EXCHANGE_MS } from "../src/panel/phase";
import { exchangeOf, exchangesOf, fixtureExchange } from "./panel-helpers";

const NOW = Date.parse("2026-11-28T12:00:00Z");
/** The file has been quiet exactly long enough for a possible permission wait. */
const QUIET = NOW - PERMISSION_QUIET_MS;

const prompt = (mode?: string, uuid = "p") => ({ type: "user", uuid, permissionMode: mode, message: { content: "Do it" } });
let n = 0;
const use = (id: string, name: string, input: object = {}) => ({
  type: "assistant",
  uuid: `a${++n}`,
  timestamp: "2026-11-28T11:59:00.000Z",
  message: { id: `m${n}`, model: "m", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string) => ({ type: "user", uuid: `r${++n}`, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const text = (words: string, stop: string | null = "end_turn") => ({
  type: "assistant",
  uuid: `t${++n}`,
  timestamp: "2026-11-28T11:59:30.000Z",
  message: { id: `m${n}`, model: "m", stop_reason: stop, content: [{ type: "text", text: words }] },
});
const interrupt = { type: "user", uuid: "i", message: { content: "[Request interrupted by user]" } };
const apiError = { type: "assistant", uuid: "e", isApiErrorMessage: true, message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "API Error: overloaded" }] } };

test("waiting: an unanswered AskUserQuestion is a certain question, at once", () => {
  const waiting = detectWaiting(fixtureExchange("ask-user-question-pending"), NOW, NOW);
  assert.equal(waiting?.kind, "question");
  assert.equal(waiting?.confidence, "certain");
  assert.equal(waiting?.id, "toolu_ask");
});

test("waiting: the answer clears the question", () => {
  assert.equal(detectWaiting(fixtureExchange("ask-user-question-answered"), NOW, QUIET), null);
});

test("waiting: a finished reply ending in a question is a likely question, also before closing marks", () => {
  for (const words of [
    "Should I use Postgres?",
    "Which one do you want (A or B?)",
    'Shall I call it "v2?"',
    "Plan:\n\n1. Do X\n\nOK to go ahead?  \n",
    "Ready? **Proceed?**",
    "Run it with `ls`?",
    "Like this:\n\n```md\n~~~\nnested\n~~~\n```\n\nLooks right?",
    "Run:\n```\nnpm test\n```\nShall I run it?",
  ]) {
    const waiting = detectWaiting(exchangeOf([prompt(), text(words)]), NOW, QUIET);
    assert.equal(waiting?.confidence, "likely", words);
    assert.equal(waiting?.id, "text:p", words);
    assert.equal(waiting?.since, "2026-11-28T11:59:30.000Z");
  }
  assert.equal(detectWaiting(fixtureExchange("plain-text-question"), NOW, QUIET)?.confidence, "likely");
});

test("waiting: a ? mid-paragraph, in an earlier paragraph, in inline code or in a code block is not a question", () => {
  for (const words of [
    "Is it fast? Yes, it is.",
    "Should I go on?\n\nDone, I went ahead.",
    "Here it is:\n\n```ts\nconst ok = a ? b : c?\n```",
    "Unclosed:\n\n```\nwhat?",
    "Run `ls?`",
  ]) {
    assert.equal(detectWaiting(exchangeOf([prompt(), text(words)]), NOW, QUIET), null, words);
  }
});

test("waiting: a blank text part after the question doesn't hide it", () => {
  const exchange = exchangeOf([prompt(), text("Should I proceed?", null), text("\n\n")]);
  assert.equal(detectWaiting(exchange, NOW, QUIET)?.confidence, "likely");
});

test("waiting: a text question needs a reply that finished normally and wasn't followed by a new prompt", () => {
  const [replaced] = exchangesOf([prompt(undefined, "p1"), text("Should I continue?"), prompt(undefined, "p2")]);
  assert.equal(detectWaiting(replaced, NOW, QUIET), null, "replaced");
  assert.equal(detectWaiting(exchangeOf([prompt(), text("Should I continue?"), interrupt]), NOW, QUIET), null, "interrupted");
  assert.equal(detectWaiting(exchangeOf([prompt(), text("Should I continue?", null), apiError]), NOW, QUIET), null, "API error");
});

test("waiting: a pending tool may be waiting for permission only after 3 s of quiet", () => {
  const exchange = exchangeOf([prompt(), use("b", "Bash", { command: "rm -rf build" })]);
  assert.equal(detectWaiting(exchange, NOW, NOW - PERMISSION_QUIET_MS + 1), null);
  assert.deepEqual(detectWaiting(exchange, NOW, QUIET), { kind: "permission", confidence: "possible", since: "2026-11-28T11:59:00.000Z", id: "b" });
});

test("waiting: never for tools that don't ask; never under bypassPermissions; edits not under acceptEdits", () => {
  for (const tool of ["Read", "Grep", "Glob", "TodoWrite", "Task", "Agent"]) {
    assert.equal(detectWaiting(exchangeOf([prompt(), use("c", tool)]), NOW, QUIET), null, tool);
  }
  assert.equal(detectWaiting(exchangeOf([prompt("bypassPermissions"), use("b", "Bash")]), NOW, QUIET), null);
  for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) {
    assert.equal(detectWaiting(exchangeOf([prompt("acceptEdits"), use("e", tool)]), NOW, QUIET), null, tool);
    assert.equal(detectWaiting(exchangeOf([prompt("default"), use("e", tool)]), NOW, QUIET)?.confidence, "possible", tool);
  }
  assert.equal(detectWaiting(exchangeOf([prompt("acceptEdits"), use("b", "Bash")]), NOW, QUIET)?.confidence, "possible", "acceptEdits still asks for commands");
});

test("waiting: the oldest pending call is the one that may be asking; calls queued behind it aren't asked yet (A15)", () => {
  assert.equal(detectWaiting(exchangeOf([prompt(), use("b", "Bash"), use("t", "Task")]), NOW, QUIET)?.id, "b", "Bash before a sub-agent");
  assert.equal(detectWaiting(exchangeOf([prompt(), use("t", "Task"), use("b", "Bash")]), NOW, QUIET), null, "a running sub-agent, Bash queued");
  assert.equal(detectWaiting(exchangeOf([prompt(), use("e1", "Edit"), use("e2", "Edit")]), NOW, QUIET)?.id, "e1");
});

test("waiting: a result clears a permission wait", () => {
  assert.equal(detectWaiting(exchangeOf([prompt(), use("b", "Bash"), result("b")]), NOW, QUIET), null);
});

test("waiting: an ended exchange waits for nothing, even with a call that never got its result", () => {
  const [replaced] = exchangesOf([prompt(undefined, "p1"), use("q", "AskUserQuestion", { questions: [] }), prompt(undefined, "p2")]);
  assert.equal(detectWaiting(replaced, NOW, QUIET), null, "replaced");
  assert.equal(detectWaiting(exchangeOf([prompt(), use("b", "Bash"), interrupt]), NOW, QUIET), null, "interrupted");
  assert.equal(detectWaiting(exchangeOf([prompt(), use("b", "Bash"), apiError]), NOW, QUIET), null, "API error");
  assert.equal(detectWaiting(exchangeOf([prompt(), use("b", "Bash")]), NOW, NOW - STALE_EXCHANGE_MS), null, "stale");
});
