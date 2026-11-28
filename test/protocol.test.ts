import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SNAPSHOT_EXCHANGES, parseHostMessage, parseWebviewMessage, PROTOCOL_VERSION, SIMPLE_ACTIONS, type ExchangeView, type PanelError } from "../src/protocol";

const v = PROTOCOL_VERSION;

const error: PanelError = { code: "NO_MODEL", message: "No model is set up for extraction.", details: null, actions: ["setUpModel", "retryExtraction"] };

function exchange(id = "p1"): ExchangeView {
  const step = { callId: "toolu_1", tool: "Bash", target: null, command: "npm install prisma", description: "Install Prisma", diffStat: null, outcome: "pending" as const };
  return {
    id,
    prompt: { author: { kind: "human", name: "Priya" }, text: "Move users to Postgres", at: "2026-11-27T13:58:30.000Z" },
    response: {
      model: "claude-opus-5-5",
      phase: "working",
      endReason: null,
      startedAt: "2026-11-27T13:58:30.000Z",
      durationMs: null,
      activity: "Install Prisma…",
      waiting: { kind: "permission", confidence: "possible", since: "2026-11-27T14:05:02.000Z", questionId: null, step },
      errorText: null,
      questions: [
        {
          id: "toolu_q",
          source: "tool",
          items: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: null }], multiSelect: false }],
          answers: [{ question: "Which database?", answer: "Postgres" }],
          answered: true,
        },
      ],
      files: [{ path: "prisma/schema.prisma", kind: "added", added: 38, removed: null }],
      reply: [{ type: "text", markdown: "I'll switch…" }, { type: "step", step }],
    },
    decisions: {
      state: "done",
      items: [
        {
          id: "9e1f",
          seq: 15,
          decision: "Store users in Postgres.",
          rationale: null,
          quote: "store users in Postgres",
          author: { kind: "human", name: "Priya" },
          grades: [{ name: "Code span", grade: 4, max: 5, low: "one line", high: "whole codebase" }],
          replaces: { id: "02ab", seq: 9, decision: "Store users in MongoDB.", authorName: "Sam" },
        },
      ],
      nodes: [{ id: "3f9a2c1e", shortId: "3f9a2c1", branch: "main" }],
      error: null,
    },
  };
}

const snapshot = () => ({
  v,
  type: "snapshot",
  session: { id: "s1", title: "Move users to Postgres", lastActivityAt: "2026-11-27T14:02:11.000Z", following: "auto", otherActiveCount: 0 },
  exchanges: [exchange()],
  hasEarlier: false,
  ledger: { branch: "main", detachedAt: null, extractionEnabled: true },
  problem: null,
});

function rejected(result: ReturnType<typeof parseHostMessage> | ReturnType<typeof parseWebviewMessage>, reasonPattern: RegExp) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, reasonPattern);
  return result;
}

test("protocol: each host message passes with a valid example", () => {
  for (const message of [
    snapshot(),
    { ...snapshot(), session: null, exchanges: [], problem: { code: "NO_SESSION_FOUND", message: "No session.", details: { claudeCodeInstalled: true }, actions: ["rescanSessions"] } },
    { v, type: "exchangeUpserted", exchange: exchange() },
    { v, type: "exchangesPrepended", exchanges: [exchange("p0")], hasEarlier: true },
    { v, type: "actionResult", requestId: "r1", ok: false, error },
    { v, type: "actionResult", requestId: "r2", ok: true, error: null },
  ]) {
    const result = parseHostMessage(message);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    if (result.ok) assert.deepEqual(result.message, message);
  }
});

test("protocol: each webview message passes with a valid example", () => {
  const messages: object[] = [
    { v, type: "ready" },
    ...SIMPLE_ACTIONS.map((type) => ({ v, type, requestId: `r-${type}` })),
    { v, type: "openRecord", requestId: "r1", recordId: "9e1f" },
    { v, type: "revealNode", requestId: "r2", nodeId: "3f9a" },
    { v, type: "openFile", requestId: "r3", exchangeId: "p1", path: "prisma/schema.prisma" },
    { v, type: "loadEarlier", requestId: "r4", beforeExchangeId: "p1" },
    { v, type: "protocolError", receivedType: null, reason: "message.v: expected 1" },
    { v, type: "reloadRequest" },
  ];
  for (const message of messages) {
    const result = parseWebviewMessage(message);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    if (result.ok) assert.deepEqual(result.message, message);
  }
});

test("protocol: a missing or wrong-typed field is rejected, naming where", () => {
  const noTitle = snapshot();
  delete (noTitle.session as Partial<typeof noTitle.session>).title;
  rejected(parseHostMessage(noTitle), /message\.session\.title: missing/);
  const badFile = { v, type: "exchangeUpserted", exchange: { ...exchange(), response: { ...exchange().response, files: [{ path: 3, kind: "added", added: 1, removed: 0 }] } } };
  rejected(parseHostMessage(badFile), /message\.exchange\.response\.files\[0\]\.path: expected a string, got number/);
  rejected(parseHostMessage({ v, type: "actionResult", requestId: "r", ok: "yes", error: null }), /message\.ok: expected true or false/);
  rejected(parseHostMessage({ ...snapshot(), problem: { ...error, code: "SOMETHING_ELSE" } }), /message\.problem\.code/);
  rejected(parseHostMessage({ ...snapshot(), problem: { ...error, actions: ["deleteEverything"] } }), /message\.problem\.actions\[0\]/);
  rejected(parseWebviewMessage({ v, type: "openFile", requestId: "r", exchangeId: "p1" }), /message\.path: missing/);
  rejected(parseWebviewMessage({ v, type: "openRecord", requestId: "r", recordId: "" }), /message\.recordId: expected a non-empty string/);
});

test("protocol: an action without a requestId is rejected; one that has a requestId reports it back", () => {
  rejected(parseWebviewMessage({ v, type: "retryExtraction" }), /message\.requestId: missing/);
  const result = rejected(parseWebviewMessage({ v, type: "openFile", requestId: "r9", exchangeId: "p1", path: 42 }), /message\.path/);
  assert.equal(!result.ok && result.requestId, "r9");
  assert.equal(!result.ok && result.receivedType, "openFile");
});

test("protocol: unknown types, the wrong version, non-objects and the reserved saveDecision are rejected", () => {
  rejected(parseHostMessage({ v, type: "explode" }), /message\.type: expected snapshot or exchangeUpserted/);
  rejected(parseWebviewMessage({ v, type: "runShell", requestId: "r", command: "rm -rf /" }), /message\.type/);
  const wrongVersion = rejected(parseHostMessage({ ...snapshot(), v: 2 }), /message\.v: expected 1, got 2/);
  assert.equal(!wrongVersion.ok && wrongVersion.version, 2);
  rejected(parseWebviewMessage({ type: "ready" }), /message\.v: expected 1/);
  for (const raw of [null, "ready", [], 42]) rejected(parseWebviewMessage(raw), /message: expected an object/);
  rejected(parseWebviewMessage({ v, type: "saveDecision", requestId: "r", exchangeId: "p1", partIndex: 0, quote: "x" }), /reserved/);
});

test("protocol: unknown fields are stripped at every level", () => {
  const extra = snapshot() as Record<string, unknown>;
  extra.secret = "nope";
  (extra.ledger as Record<string, unknown>).internalPath = "C:/Users/x/.claude";
  const ex = exchange() as unknown as Record<string, unknown>;
  (ex.response as Record<string, unknown>).byteOffset = 1234;
  extra.exchanges = [ex];
  const result = parseHostMessage(extra);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.message, snapshot());
  const withExtrasInParts = exchange() as unknown as { response: { reply: Record<string, unknown>[] } };
  withExtrasInParts.response.reply[0].html = "<script>";
  (withExtrasInParts.response.reply[1].step as Record<string, unknown>).output = "file contents";
  const upsert = parseHostMessage({ v, type: "exchangeUpserted", exchange: withExtrasInParts });
  assert.deepEqual(upsert.ok && upsert.message, { v, type: "exchangeUpserted", exchange: exchange() }, "fields inside tagged variants are stripped too");
  const action = parseWebviewMessage({ v, type: "openRecord", requestId: "r", recordId: "9e1f", path: "../../.ssh/id_rsa" });
  assert.deepEqual(action.ok && action.message, { v, type: "openRecord", requestId: "r", recordId: "9e1f" });
});

test("protocol: a snapshot carries at most the latest MAX_SNAPSHOT_EXCHANGES exchanges", () => {
  const tooMany = { ...snapshot(), exchanges: Array.from({ length: MAX_SNAPSHOT_EXCHANGES + 1 }, (_, i) => exchange(`p${i}`)) };
  rejected(parseHostMessage(tooMany), /at most 30/);
});
