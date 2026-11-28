import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { ApiError, ConfigError, ModelOutputError, NoModelError } from "../src/core";
import { parseHostMessage, PROTOCOL_VERSION, type DecisionSectionView } from "../src/protocol";
import { displayPath } from "../src/panel/paths";
import { toPanelError } from "../src/panel/errors";
import { deriveExchange, toDecisionSectionView, toExchangeView } from "../src/panel/view";
import type { LinkedDecision } from "../src/panel/linker";
import { exchangeOf, FIXTURES, fixtureExchange } from "./panel-helpers";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const NO_DECISIONS: DecisionSectionView = { state: "done", items: [], nodes: [], error: null };

function view(exchange = fixtureExchange("edit-write-multiedit-notebook"), workspace = "/work/proj") {
  return toExchangeView({ exchange, derived: deriveExchange(exchange, NOW, NOW), decisions: NO_DECISIONS, humanName: "Priya", workspace });
}

/** Paths of every undefined value, so "nullable, never optional" fails loudly. */
function undefinedFields(value: unknown, at = "view"): string[] {
  if (value === undefined) return [at];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => undefinedFields(inner, `${at}.${key}`));
}

test("display paths: relative inside the workspace with /, absolute outside, Windows separators and case handled", () => {
  assert.equal(displayPath("/work/proj/src/db.ts", "/work/proj", "linux"), "src/db.ts");
  assert.equal(displayPath("/etc/hosts", "/work/proj", "linux"), "/etc/hosts");
  assert.equal(displayPath("/work/project2/a.ts", "/work/proj", "linux"), "/work/project2/a.ts", "a sibling folder with the same prefix is outside");
  assert.equal(displayPath("C:\\Users\\Priya\\app\\src\\Db.ts", "c:\\users\\priya\\app", "win32"), "src/Db.ts", "case-insensitive match, file casing kept");
  assert.equal(displayPath("/c/Users/Priya/app/src/db.ts", "C:\\Users\\Priya\\app", "win32"), "src/db.ts", "Git Bash path");
  assert.equal(displayPath("D:\\other\\x.ts", "C:\\Users\\Priya\\app", "win32"), "D:/other/x.ts");
  assert.equal(displayPath("C:\\Users\\Priya\\app\\..\\secrets.txt", "C:\\Users\\Priya\\app", "win32"), "C:/Users/Priya/secrets.txt");
  assert.equal(displayPath("src\\db.ts", "C:\\Users\\Priya\\app", "win32"), "src/db.ts", "a relative path is relative to the workspace");
  assert.equal(displayPath("src/db.ts", "/work/proj", "linux"), "src/db.ts");
});

test("view: every fixture maps to a view the protocol accepts, with null and never undefined", () => {
  for (const name of fs.readdirSync(FIXTURES).map((f) => f.replace(/\.jsonl$/, ""))) {
    const exchange = fixtureExchange(name);
    if (!exchange) continue; // fixtures with no prompt
    const mapped = view(exchange);
    assert.deepEqual(undefinedFields(mapped), [], name);
    const checked = parseHostMessage({ v: PROTOCOL_VERSION, type: "exchangeUpserted", exchange: mapped });
    assert.ok(checked.ok, `${name}: ${checked.ok ? "" : checked.reason}`);
  }
});

test("view: steps carry display paths, diff stats and outcomes; files are relative", () => {
  const mapped = view();
  const steps = mapped.response.reply.flatMap((p) => (p.type === "step" ? [p.step] : []));
  assert.deepEqual(
    steps.map((s) => [s.tool, s.target, s.diffStat, s.outcome]),
    [
      ["Edit", "src/db.ts", { added: 3, removed: 2 }, "ran"],
      ["Write", "src/migrate.ts", { added: 4, removed: 0 }, "ran"],
      ["MultiEdit", "src/user.ts", { added: 3, removed: 3 }, "ran"],
      ["NotebookEdit", "analysis.ipynb", { added: null, removed: null }, "ran"],
    ]
  );
  assert.deepEqual(mapped.response.files.map((f) => f.path), ["src/db.ts", "src/migrate.ts", "src/user.ts", "analysis.ipynb"]);
  assert.equal(mapped.response.phase, "ended");
  assert.equal(mapped.response.activity, null);
  assert.equal(typeof mapped.response.durationMs, "number");
  assert.deepEqual(mapped.prompt.author, { kind: "human", name: "Priya" });
});

test("view: a denied call is denied; a working reply has an activity and no duration; an API error carries its text", () => {
  const denied = view(fixtureExchange("tool-denied"));
  assert.deepEqual(denied.response.reply.flatMap((p) => (p.type === "step" ? [p.step.outcome] : [])), ["denied"]);
  assert.equal(denied.response.endReason, "stoppedByUser");
  const working = view(fixtureExchange("ask-user-question-pending"));
  assert.equal(working.response.phase, "working");
  assert.equal(working.response.durationMs, null);
  assert.equal(working.response.activity, "Asking you a question…");
  assert.deepEqual(working.response.waiting && { kind: working.response.waiting.kind, confidence: working.response.waiting.confidence, questionId: working.response.waiting.questionId }, {
    kind: "question",
    confidence: "certain",
    questionId: "toolu_ask",
  });
  const error = view(fixtureExchange("api-error"));
  assert.equal(error.response.endReason, "error");
  assert.ok(error.response.errorText);
});

test("view: questions from AskUserQuestion with their answers, and a question the reply closed with", () => {
  const answered = view(fixtureExchange("ask-user-question-answered")).response.questions;
  assert.equal(answered.length, 1);
  assert.equal(answered[0].source, "tool");
  assert.equal(answered[0].answered, true);
  assert.ok(answered[0].answers && answered[0].answers.length > 0);
  const text = view(fixtureExchange("plain-text-question")).response.questions;
  assert.deepEqual(text.map((q) => [q.source, q.answered, q.items[0].options.length]), [["text", false, 0]]);
  const prompt = (uuid: string) => ({ type: "user", uuid, message: { content: "Go" } });
  const reply = { type: "assistant", uuid: "a", message: { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "Postgres or SQLite?" }] } };
  const replaced = exchangeOf([prompt("p1"), reply, prompt("p2")]);
  assert.equal(view(replaced).response.questions[0].answered, true, "the next prompt answered it");
});

test("view: a permission wait shows its step, read-only", () => {
  const exchange = exchangeOf([
    { type: "user", uuid: "p", message: { content: "Clean up" } },
    { type: "assistant", uuid: "a", timestamp: "2026-11-28T11:59:00.000Z", message: { model: "m", stop_reason: "tool_use", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "rm -rf build", description: "Remove the build folder" } }] } },
  ]);
  const mapped = toExchangeView({ exchange, derived: deriveExchange(exchange, NOW, NOW - 5000), decisions: NO_DECISIONS, humanName: "Priya", workspace: "/w" });
  assert.deepEqual(mapped.response.waiting?.step && [mapped.response.waiting.step.command, mapped.response.waiting.step.outcome], ["rm -rf build", "pending"]);
});

const linked = (seq: number, nodeHash: string): LinkedDecision => ({
  hash: `rec${seq}`,
  record: {
    type: "record",
    seq,
    decision: `Decision ${seq}`,
    source: { turn: "t", quote: seq === 1 ? "in Postgres" : undefined },
    grades: { codeSpan: 4 },
    author: { kind: "ai", name: "claude-opus-5-5" },
    timestamp: "x",
  },
  nodeHash,
  grades: [{ name: "Code span", grade: 4, low: "one line", high: undefined }],
  replaces: seq === 2 ? { hash: "rec1", seq: 1, decision: "Decision 1", authorName: "Sam" } : null,
});

test("decision section: items in order, each node once, grades out of the scale, error only in error states", () => {
  const section = toDecisionSectionView({ state: "done", linked: [linked(1, "node-a"), linked(2, "node-a"), linked(3, "node-b")], branch: "main", failure: null });
  assert.deepEqual(section.items.map((d) => d.seq), [1, 2, 3]);
  assert.deepEqual(section.nodes, [
    { id: "node-a", shortId: "node-a", branch: "main" },
    { id: "node-b", shortId: "node-b", branch: "main" },
  ]);
  assert.deepEqual(section.items[0].grades, [{ name: "Code span", grade: 4, max: 5, low: "one line", high: null }]);
  assert.equal(section.items[0].quote, "in Postgres");
  assert.equal(section.items[1].quote, null);
  assert.deepEqual(section.items[1].replaces, { id: "rec1", seq: 1, decision: "Decision 1", authorName: "Sam" });
  assert.deepEqual(undefinedFields(section), []);
  const failure = { error: new NoModelError("none"), retryAt: null };
  assert.equal(toDecisionSectionView({ state: "noModel", linked: [], branch: null, failure }).error?.code, "NO_MODEL");
  assert.equal(toDecisionSectionView({ state: "extracting", linked: [], branch: null, failure }).error, null);
});

test("errors: each domain error maps to its catalog code and actions", () => {
  const retryAt = Date.parse("2026-11-28T12:05:00Z");
  const cases: [unknown, Parameters<typeof toPanelError>[1], string, string[]][] = [
    [new ApiError("anthropic", 401, "x"), {}, "EXTRACTION_API_FAILED", ["setUpModel", "retryExtraction"]],
    [new ApiError("gemini", 403, "x"), {}, "EXTRACTION_API_FAILED", ["setUpModel", "retryExtraction"]],
    [new ApiError("anthropic", 429, "x"), { retryAt }, "EXTRACTION_API_FAILED", ["retryExtraction"]],
    [new ApiError("anthropic", 529, "x"), {}, "EXTRACTION_API_FAILED", ["retryExtraction"]],
    [new ModelOutputError("not JSON", "reply"), { retryAt }, "EXTRACTION_REPLY_UNREADABLE", ["retryExtraction"]],
    [new NoModelError("no key"), {}, "NO_MODEL", ["setUpModel", "retryExtraction"]],
    [new ConfigError(".ledger/config.json is not valid JSON"), {}, "LEDGER_CONFIG_INVALID", ["editParameters", "retryExtraction"]],
    [Object.assign(new Error("gone"), { code: "ENOENT" }), { scope: "session" }, "SESSION_UNREADABLE", ["rescanSessions", "chooseSession"]],
    [Object.assign(new Error("denied"), { code: "EACCES" }), { scope: "ledger" }, "LEDGER_UNREADABLE", ["openOutput"]],
    [new Error("disk full"), {}, "EXTRACTION_FAILED", ["retryExtraction", "openOutput"]],
  ];
  for (const [error, context, code, actions] of cases) {
    const panel = toPanelError(error, context);
    assert.equal(panel.code, code, String(error));
    assert.deepEqual(panel.actions, actions, String(error));
  }
  assert.deepEqual(toPanelError(new ApiError("anthropic", 429, "x"), { retryAt }).details, { provider: "anthropic", status: 429, retryAt: "2026-11-28T12:05:00.000Z" });
  assert.match(toPanelError(new ApiError("anthropic", 529, "x")).message, /The Anthropic API is unavailable \(529\)\./);
  assert.deepEqual(toPanelError(Object.assign(new Error("x"), { code: "EACCES" }), { scope: "session" }).details, { reason: "permission was denied" });
});

test("errors: no message carries a key, a model reply, a provider's response body or a stack", () => {
  const leaky = [
    new ApiError("anthropic", 401, "Anthropic API 401: invalid x-api-key sk-ant-SECRET123 {\"error\":\"body\"}"),
    new ModelOutputError("Model reply is not JSON", "SECRET_REPLY decisions about user data"),
    Object.assign(new Error("SECRET_INTERNAL at C:\\Users\\Priya\\.claude\\x.jsonl"), { stack: "Error: SECRET_STACK\n    at foo (bar.js:1:1)" }),
  ];
  for (const error of leaky) {
    for (const scope of ["section", "session", "ledger"] as const) {
      const text = JSON.stringify(toPanelError(error, { scope }));
      for (const secret of ["SECRET", "sk-ant", "body", "at foo", ".claude"]) assert.ok(!text.includes(secret), `${scope}: ${text}`);
    }
  }
});
