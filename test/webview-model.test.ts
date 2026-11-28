import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type ExchangeView, type HostMessage } from "../src/protocol";
import { EMPTY_STORE, reduce, type PanelStore } from "../src/webview/model/store";
import { ago, durationClock, durationWords, headerText } from "../src/webview/model/format";
import { parseMarkdown, parseInline } from "../src/webview/model/markdown";
import { ERROR_TITLES, waitingText } from "../src/webview/model/copy";

const v = PROTOCOL_VERSION;

function exchange(id: string, text = "Hi"): ExchangeView {
  return {
    id,
    prompt: { author: { kind: "human", name: "Priya" }, text, at: "2026-11-28T10:00:00.000Z" },
    response: {
      model: null,
      phase: "ended",
      endReason: "done",
      startedAt: "2026-11-28T10:00:00.000Z",
      durationMs: 1000,
      activity: null,
      waiting: null,
      errorText: null,
      questions: [],
      files: [],
      reply: [],
    },
    decisions: { state: "done", items: [], nodes: [], error: null },
  };
}

const snapshot = (exchanges: ExchangeView[], hasEarlier = false): HostMessage => ({
  v,
  type: "snapshot",
  session: { id: "s", title: "t", lastActivityAt: "x", following: "auto", otherActiveCount: 0 },
  exchanges,
  hasEarlier,
  ledger: { branch: "main", detachedAt: null, extractionEnabled: true },
  problem: null,
});
const apply = (store: PanelStore, ...messages: HostMessage[]) => messages.reduce((s, message) => reduce(s, { kind: "message", message }), store);
const ids = (store: PanelStore) => store.exchanges.map((e) => e.id);

test("store: a snapshot replaces everything", () => {
  const first = apply(EMPTY_STORE, snapshot([exchange("a"), exchange("b")]));
  const second = apply(first, snapshot([exchange("c")], true));
  assert.deepEqual(ids(second), ["c"]);
  assert.equal(second.hasEarlier, true);
  assert.deepEqual(second.changed, ["c"]);
});

test("store: an upsert replaces by id in place, or adds at the end; only it is marked changed", () => {
  const store = apply(EMPTY_STORE, snapshot([exchange("a"), exchange("b")]), { v, type: "exchangeUpserted", exchange: exchange("a", "Edited") });
  assert.deepEqual(ids(store), ["a", "b"]);
  assert.equal(store.exchanges[0].prompt.text, "Edited");
  assert.deepEqual(store.changed, ["a"]);
  assert.deepEqual(ids(apply(store, { v, type: "exchangeUpserted", exchange: exchange("c") })), ["a", "b", "c"]);
});

test("store: earlier exchanges are prepended in order, without duplicates", () => {
  const store = apply(EMPTY_STORE, snapshot([exchange("c"), exchange("d")], true), {
    v,
    type: "exchangesPrepended",
    exchanges: [exchange("a"), exchange("b"), exchange("c")],
    hasEarlier: false,
  });
  assert.deepEqual(ids(store), ["a", "b", "c", "d"]);
  assert.equal(store.hasEarlier, false);
  assert.deepEqual(store.changed, ["a", "b"]);
});

test("store: updates before the first snapshot are ignored", () => {
  const store = apply(EMPTY_STORE, { v, type: "exchangeUpserted", exchange: exchange("a") }, { v, type: "exchangesPrepended", exchanges: [exchange("b")], hasEarlier: false });
  assert.equal(store, EMPTY_STORE);
});

test("store: a version mismatch shows the reload problem and clears the exchanges", () => {
  const store = reduce(apply(EMPTY_STORE, snapshot([exchange("a")])), { kind: "versionMismatch", received: 2 });
  assert.equal(store.problem?.code, "PROTOCOL_VERSION_MISMATCH");
  assert.deepEqual(store.problem?.details, { received: 2, expected: PROTOCOL_VERSION });
  assert.deepEqual(store.exchanges, []);
});

test("store: a failed action's error is kept until the next one succeeds", () => {
  const error = { code: "NOT_FOUND" as const, message: "x", details: null, actions: [] };
  const failed = apply(EMPTY_STORE, snapshot([]), { v, type: "actionResult", requestId: "r", ok: false, error });
  assert.equal(failed.actionError?.code, "NOT_FOUND");
  assert.equal(apply(failed, { v, type: "actionResult", requestId: "s", ok: true, error: null }).actionError, null);
});

test("format: durations in words and on a clock; the header for each ending", () => {
  assert.equal(durationWords(41_000), "41s");
  assert.equal(durationWords(221_000), "3m 41s");
  assert.equal(durationWords(3_720_000), "1h 2m");
  assert.equal(durationClock(41_000), "0:41");
  assert.equal(durationClock(221_000), "3:41");
  assert.equal(durationClock(3_723_000), "1:02:03");
  assert.equal(headerText({ phase: "working", endReason: null, durationMs: null }), "Working");
  assert.equal(headerText({ phase: "ended", endReason: "done", durationMs: 221_000 }), "Done in 3m 41s");
  assert.equal(headerText({ phase: "ended", endReason: "stoppedByUser", durationMs: 41_000 }), "Stopped by you after 0:41");
  assert.equal(headerText({ phase: "ended", endReason: "error", durationMs: 22_000 }), "Stopped by an error after 0:22");
  assert.equal(headerText({ phase: "ended", endReason: "done", durationMs: null }), "Done");
  assert.match(headerText({ phase: "ended", endReason: "incomplete", durationMs: 5000 }), /Unfinished/);
  assert.deepEqual([ago(5_000), ago(120_000), ago(3 * 3_600_000), ago(2 * 86_400_000)], ["just now", "2m ago", "3h ago", "2d ago"]);
});

test("copy: every error code has a title; waiting wording follows the confidence", () => {
  for (const [code, title] of Object.entries(ERROR_TITLES)) assert.ok(title.length > 0, code);
  assert.equal(waitingText({ kind: "question", confidence: "certain" }), "Waiting for your answer in Claude Code");
  assert.equal(waitingText({ kind: "permission", confidence: "possible" }), "Claude Code may be waiting for your permission");
});

test("markdown: paragraphs, headings, lists, emphasis, inline code, fenced code and links", () => {
  assert.deepEqual(parseMarkdown("# Plan\n\nUse **Postgres** and *keep* `users`.\n\n- one\n- two\n  more\n\n1. first\n2. second\n\n```ts\nconst x = 1;\n```"), [
    { type: "heading", level: 1, inlines: [{ type: "text", text: "Plan" }] },
    {
      type: "paragraph",
      inlines: [
        { type: "text", text: "Use " },
        { type: "strong", children: [{ type: "text", text: "Postgres" }] },
        { type: "text", text: " and " },
        { type: "em", children: [{ type: "text", text: "keep" }] },
        { type: "text", text: " " },
        { type: "code", text: "users" },
        { type: "text", text: "." },
      ],
    },
    { type: "list", ordered: false, items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two\nmore" }]] },
    { type: "list", ordered: true, items: [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]] },
    { type: "code", lang: "ts", text: "const x = 1;" },
  ]);
  assert.deepEqual(parseInline("See [the docs](https://example.dev/a)."), [
    { type: "text", text: "See " },
    { type: "link", href: "https://example.dev/a", children: [{ type: "text", text: "the docs" }] },
    { type: "text", text: "." },
  ]);
});

test("markdown: raw HTML stays text; javascript: and other links stay text", () => {
  assert.deepEqual(parseInline('<img src=x onerror="alert(1)"> <b>bold</b>'), [{ type: "text", text: '<img src=x onerror="alert(1)"> <b>bold</b>' }]);
  for (const href of ["javascript:alert(1)", "command:ledger.openRecord", "file:///etc/passwd", "vscode://x", "data:text/html,x"]) {
    const inlines = parseInline(`[click](${href})`);
    assert.ok(inlines.every((i) => i.type === "text"), `${href}: no link`);
    assert.equal(inlines.map((i) => (i.type === "text" ? i.text : "")).join(""), `[click](${href})`, href);
  }
});

test("markdown: an unterminated fence runs to the end; snake_case and lone stars aren't emphasis", () => {
  assert.deepEqual(parseMarkdown("Here:\n\n```js\nlet a = 1;\nlet b = 2;"), [
    { type: "paragraph", inlines: [{ type: "text", text: "Here:" }] },
    { type: "code", lang: "js", text: "let a = 1;\nlet b = 2;" },
  ]);
  assert.deepEqual(parseInline("call user_id_map and 2 * 3 * 4"), [{ type: "text", text: "call user_id_map and 2 * 3 * 4" }]);
  assert.deepEqual(parseInline("unclosed **bold and `code"), [{ type: "text", text: "unclosed **bold and `code" }]);
});

test("markdown: headings keep a # that is part of a word and drop a closing run", () => {
  assert.deepEqual(parseMarkdown("## Use C#"), [{ type: "heading", level: 2, inlines: [{ type: "text", text: "Use C#" }] }]);
  assert.deepEqual(parseMarkdown("# Title ##  "), [{ type: "heading", level: 1, inlines: [{ type: "text", text: "Title" }] }]);
  assert.deepEqual(parseMarkdown("#hashtag"), [{ type: "paragraph", inlines: [{ type: "text", text: "#hashtag" }] }]);
});

test("markdown: adversarial input stays fast (no regex blow-up, no rescanning unclosed markers)", () => {
  const timed = (input: string, parse: (s: string) => unknown) => {
    const started = Date.now();
    parse(input);
    return Date.now() - started;
  };
  assert.ok(timed("# a" + " ".repeat(20_000) + "x", parseMarkdown) < 500, "spaces in a heading");
  assert.ok(timed("a" + "`".repeat(20_000), parseInline) < 500, "a run of backticks that never closes");
  assert.ok(timed("a`b".repeat(20_000), parseInline) < 500, "many single backticks, none closing");
  assert.ok(timed("[a](".repeat(40_000), parseInline) < 500, "links that never close");
  assert.deepEqual(parseInline("a ``` b"), [{ type: "text", text: "a ``` b" }]);
});

test("markdown: very long lines and deep nesting stay fast and bounded", () => {
  const long = "word ".repeat(50_000) + "**end**";
  const started = Date.now();
  const blocks = parseMarkdown(long);
  assert.ok(Date.now() - started < 1000, "parses a 250 KB line quickly");
  assert.equal(blocks.length, 1);
  const deep = "*".repeat(40) + "x" + "*".repeat(40);
  assert.doesNotThrow(() => parseInline(deep));
  const manyStars = "*a ".repeat(20_000);
  const t = Date.now();
  parseInline(manyStars);
  assert.ok(Date.now() - t < 2000, "unclosed emphasis everywhere doesn't go quadratic past reason");
});
