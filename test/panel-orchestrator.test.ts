import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createSessionLogSource } from "../src/claude-log";
import { Ledger, ingest } from "../src/core";
import type { Model } from "../engine/src";
import { PROTOCOL_VERSION, type HostMessage } from "../src/protocol";
import { SessionFollower } from "../src/panel/follower";
import { DecisionLinker } from "../src/panel/linker";
import { SessionPanel, LIVE_UPDATE_MIN_INTERVAL_MS, type Clock } from "../src/panel/session-panel";
import type { HostCommands } from "../src/panel/actions";
import type { ExtractionStatus } from "../src/watcher/status";

const v = PROTOCOL_VERSION;
const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-panel-"));
  made.push(dir);
  return dir;
};
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const T0 = Date.parse("2026-11-28T10:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const line = (o: object) => JSON.stringify(o) + "\n";
const prompt = (uuid: string, seconds = 0) => line({ type: "user", uuid, timestamp: at(seconds), message: { content: `Prompt ${uuid}` } });
const text = (uuid: string, words: string, stop: string | null = "end_turn", seconds = 1) =>
  line({ type: "assistant", uuid, timestamp: at(seconds), message: { id: `m-${uuid}`, model: "claude-test", stop_reason: stop, content: [{ type: "text", text: words }] } });
const use = (uuid: string, id: string, tool: string, input: object = {}) =>
  line({ type: "assistant", uuid, timestamp: at(2), message: { id: `m-${uuid}`, model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: tool, input }] } });
const result = (uuid: string, id: string, extra: object = {}) => line({ type: "user", uuid, timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });

/** Timers run only when the test moves time forward. */
class FakeClock implements Clock {
  time = T0 + 60_000;
  private timers: { id: number; at: number; run: () => void }[] = [];
  private nextId = 1;
  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + ms, run });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  advance(ms: number) {
    const until = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.run();
    }
    this.time = until;
  }
}

function setUp(sessions: Record<string, string> = {}, options: { enabled?: boolean; pick?: string } = {}) {
  const workspace = path.join(tmp(), "proj");
  const projects = tmp();
  const dir = path.join(projects, path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir);
  const fileOf = (id: string) => path.join(dir, `${id}.jsonl`);
  Object.entries(sessions).forEach(([id, content], i) => {
    fs.writeFileSync(fileOf(id), content);
    const time = new Date(T0 + i * 1000);
    fs.utimesSync(fileOf(id), time, time);
  });
  const source = createSessionLogSource({ projectsDir: projects, workspace, pollMs: 1000, polling: "manual" });
  source.acquire();
  const clock = new FakeClock();
  const follower = new SessionFollower(source, { mode: "auto" }, () => {}, () => T0 - 60_000);
  const ledger = Ledger.open(tmp());
  const posted: HostMessage[] = [];
  const badges: [number, string][] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  let retries = 0;
  const statusListeners: ((file: string) => void)[] = [];
  const status: ExtractionStatus = { enabled: options.enabled ?? true, committedOffset: 0, inFlight: null, failure: null };
  const used: string[] = [];
  const host: HostCommands = {
    openRecord: async (hash) => void opened.push(`record:${hash}`),
    revealNode: async (hash) => void opened.push(`node:${hash}`),
    openFile: async (file) => void opened.push(`file:${file}`),
    setUpModel: async () => {},
    editParameters: async () => {},
    enableExtraction: async () => {},
    showOutput: () => {},
    pickSession: async () => options.pick,
    reload: () => {},
    isClaudeCodeInstalled: () => true,
  };
  const panel = new SessionPanel({
    source,
    follower,
    status: { status: () => status, onDidChangeStatus: (l) => (statusListeners.push(l), { dispose: () => {} }), retryNow: () => void retries++ },
    linker: new DecisionLinker(() => ledger),
    ledger: () => ledger,
    port: { post: (m) => posted.push(m), setBadge: (count, tooltip) => badges.push([count, tooltip]) },
    host,
    clock,
    workspace,
    humanName: () => "Priya",
    isExtractionEnabled: () => status.enabled,
    useSession: (file) => used.push(file),
    log: (l) => logs.push(l),
  });
  const send = (message: object) => panel.receive({ v, ...message });
  /** Messages of one type posted since the last call. */
  let seen = 0;
  const take = () => posted.slice(seen, (seen = posted.length));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { source, fileOf, workspace, clock, panel, posted, badges, logs, opened, ledger, status, statusListeners, used, send, take, settle, retries: () => retries, follower };
}

const snapshotsIn = (messages: HostMessage[]) => messages.filter((m) => m.type === "snapshot");
const upsertsIn = (messages: HostMessage[]) => messages.flatMap((m) => (m.type === "exchangeUpserted" ? [m.exchange] : []));

test("panel: ready gives exactly one snapshot with the latest 30 exchanges and hasEarlier", () => {
  const history = Array.from({ length: 32 }, (_, i) => prompt(`p${i}`, i) + text(`a${i}`, "Done.", "end_turn", i)).join("");
  const { send, take, used, fileOf } = setUp({ s1: history });
  take();
  send({ type: "ready" });
  const messages = take();
  assert.equal(messages.length, 1);
  const [snapshot] = snapshotsIn(messages);
  assert.ok(snapshot && snapshot.type === "snapshot");
  if (snapshot.type !== "snapshot") return;
  assert.equal(snapshot.exchanges.length, 30);
  assert.equal(snapshot.exchanges[0].id, "p2");
  assert.equal(snapshot.hasEarlier, true);
  assert.equal(snapshot.session?.id, "s1");
  assert.equal(snapshot.session?.title, "Prompt p0");
  assert.deepEqual(snapshot.ledger, { branch: "main", detachedAt: null, extractionEnabled: true });
  assert.ok(used.includes(fileOf("s1")), "following a session marks it used (D-020)");
});

test("panel: with no session, the snapshot says so and offers Check again", () => {
  const { send, take } = setUp();
  send({ type: "ready" });
  const [snapshot] = snapshotsIn(take());
  assert.equal(snapshot.type === "snapshot" && snapshot.session, null);
  assert.equal(snapshot.type === "snapshot" && snapshot.problem?.code, "NO_SESSION_FOUND");
});

test("panel: several lines within 250 ms become one upsert", () => {
  const { send, take, source, fileOf, clock } = setUp({ s1: prompt("p1") });
  send({ type: "ready" });
  take();
  for (const piece of [text("a1", "Looking…", null), use("a2", "r1", "Read", { file_path: "/x" }), result("r-1", "r1")]) {
    fs.appendFileSync(fileOf("s1"), piece);
    source.tick();
    clock.advance(50);
  }
  assert.equal(upsertsIn(take()).length, 0, "nothing before the interval ends");
  clock.advance(LIVE_UPDATE_MIN_INTERVAL_MS);
  const upserts = upsertsIn(take());
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].response.reply.length, 2);
});

test("panel: quiet turns a pending command into 'may be waiting' with no new line, and never badges it", () => {
  const { send, take, source, fileOf, clock, badges } = setUp({ s1: prompt("p1") });
  send({ type: "ready" });
  fs.appendFileSync(fileOf("s1"), use("a1", "b1", "Bash", { command: "rm -rf build" }));
  source.tick();
  clock.advance(LIVE_UPDATE_MIN_INTERVAL_MS);
  assert.equal(upsertsIn(take()).at(-1)?.response.waiting, null);
  clock.advance(3000);
  const waiting = upsertsIn(take()).at(-1)?.response.waiting;
  assert.equal(waiting?.confidence, "possible");
  assert.equal(waiting?.step?.command, "rm -rf build");
  assert.deepEqual(badges.filter(([count]) => count > 0), []);
});

test("panel: the badge counts certain and likely waits only", () => {
  const { send, source, fileOf, clock, badges } = setUp({ s1: prompt("p1") });
  send({ type: "ready" });
  fs.appendFileSync(fileOf("s1"), use("a1", "q1", "AskUserQuestion", { questions: [{ question: "Which DB?", options: [] }] }));
  source.tick();
  assert.equal(badges.at(-1)?.[0], 1, "an unanswered question badges at once");
  fs.appendFileSync(fileOf("s1"), result("r1", "q1", { toolUseResult: { answers: { "Which DB?": "Postgres" } } }) + text("a2", "Postgres it is. Shall I migrate now?"));
  source.tick();
  assert.equal(badges.at(-1)?.[0], 1, "a reply ending in a question is likely");
  fs.appendFileSync(fileOf("s1"), prompt("p2", 30));
  source.tick();
  clock.advance(1);
  assert.equal(badges.at(-1)?.[0], 0, "answered by the next prompt");
});

test("panel: a prompt in another session switches the panel with a snapshot", () => {
  const { send, take, source, fileOf } = setUp({ s1: prompt("p1"), s2: prompt("q1") });
  send({ type: "ready" });
  take();
  fs.appendFileSync(fileOf("s1"), prompt("p2", 120));
  source.tick();
  const messages = take();
  const [snapshot] = snapshotsIn(messages);
  assert.equal(snapshot.type === "snapshot" && snapshot.session?.id, "s1");
  assert.deepEqual(snapshot.type === "snapshot" && snapshot.exchanges.map((e) => e.id), ["p1", "p2"], "the new prompt is already in the snapshot");
  assert.equal(upsertsIn(messages).length, 0);
});

test("panel: ledgerChanged sends upserts only for exchanges whose decisions changed", async () => {
  const { send, take, ledger, panel, clock } = setUp({ s1: prompt("p1") + text("a1", "Use Postgres.") + prompt("p2", 10) + text("a2", "Done.", "end_turn", 11) });
  send({ type: "ready" });
  take();
  const model: Model = async () => JSON.stringify({ decisions: [{ decision: "Use Postgres.", turn: "1", grades: { codeSpan: 3 } }] });
  await ingest(ledger, [{ author: "ai", name: "claude-test", text: "Use Postgres.", externalId: "a1" }], model, { origin: "claude-code", session: "s1", humanName: "Priya" });
  panel.ledgerChanged();
  clock.advance(LIVE_UPDATE_MIN_INTERVAL_MS);
  const upserts = upsertsIn(take());
  assert.deepEqual(upserts.map((e) => [e.id, e.decisions.items.map((d) => d.decision)]), [["p1", ["Use Postgres."]]]);
});

test("panel: actions check their arguments against what is shown", async () => {
  const s1 = prompt("p1") + use("a1", "e1", "Edit", { file_path: "SRC", old_string: "a", new_string: "b" }) + result("r1", "e1") + text("a2", "Edited.");
  const env = setUp({ s1: "" });
  const file = path.join(env.workspace, "src", "db.ts");
  fs.writeFileSync(env.fileOf("s1"), s1.replace("SRC", file.replace(/\\/g, "\\\\")));
  env.source.tick();
  env.send({ type: "ready" });
  env.take();
  env.send({ type: "openFile", requestId: "r1", exchangeId: "p1", path: "src/db.ts" });
  env.send({ type: "openFile", requestId: "r2", exchangeId: "p1", path: "../../.ssh/id_rsa" });
  env.send({ type: "openRecord", requestId: "r3", recordId: "not-shown" });
  env.send({ type: "loadEarlier", requestId: "r4", beforeExchangeId: "unknown" });
  await env.settle();
  const results = Object.fromEntries(env.take().flatMap((m) => (m.type === "actionResult" ? [[m.requestId, m.error?.code ?? "ok"]] : [])));
  assert.deepEqual(results, { r1: "ok", r2: "NOT_FOUND", r3: "NOT_FOUND", r4: "NOT_FOUND" });
  assert.deepEqual(env.opened, [`file:${file}`]);
});

test("panel: retry while watching is off is EXTRACTION_OFF; on, it retries", async () => {
  const off = setUp({ s1: prompt("p1") }, { enabled: false });
  off.send({ type: "ready" });
  off.send({ type: "retryExtraction", requestId: "r1" });
  await off.settle();
  const result = off.take().find((m) => m.type === "actionResult");
  assert.equal(result?.type === "actionResult" && result.error?.code, "EXTRACTION_OFF");
  assert.deepEqual(result?.type === "actionResult" && result.error?.actions, ["enableExtraction"]);
  const on = setUp({ s1: prompt("p1") });
  on.send({ type: "retryExtraction", requestId: "r1" });
  await on.settle();
  assert.equal(on.retries(), 1);
});

test("panel: loadEarlier sends the exchanges before one, oldest first, then its result", async () => {
  const history = Array.from({ length: 35 }, (_, i) => prompt(`p${i}`, i) + text(`a${i}`, "Done.", "end_turn", i)).join("");
  const { send, take, settle } = setUp({ s1: history });
  send({ type: "ready" });
  take();
  send({ type: "loadEarlier", requestId: "r1", beforeExchangeId: "p5" });
  await settle();
  const [prepended, done] = take();
  assert.equal(prepended.type === "exchangesPrepended" && prepended.exchanges.map((e) => e.id).join(","), "p0,p1,p2,p3,p4");
  assert.equal(prepended.type === "exchangesPrepended" && prepended.hasEarlier, false);
  assert.deepEqual(done, { v, type: "actionResult", requestId: "r1", ok: true, error: null });
});

test("panel: invalid messages are logged and dropped; one with a requestId gets INVALID_MESSAGE", () => {
  const { panel, take, logs } = setUp({ s1: prompt("p1") });
  take();
  panel.receive({ v, type: "runShell", command: "rm -rf /" });
  panel.receive({ v: 99, type: "ready" });
  panel.receive({ v, type: "openFile", requestId: "r9", exchangeId: "p1" });
  const messages = take();
  assert.equal(logs.length, 3);
  assert.deepEqual(messages.map((m) => m.type === "actionResult" && [m.requestId, m.error?.code]), [["r9", "INVALID_MESSAGE"]]);
});

test("panel: ready while updates are queued sends one snapshot and no stale upsert after it", () => {
  const { send, take, source, fileOf, clock } = setUp({ s1: prompt("p1") });
  send({ type: "ready" });
  take();
  fs.appendFileSync(fileOf("s1"), text("a1", "Working…", null));
  source.tick();
  send({ type: "ready" });
  clock.advance(LIVE_UPDATE_MIN_INTERVAL_MS * 2);
  const messages = take();
  assert.equal(snapshotsIn(messages).length, 1);
  assert.equal(upsertsIn(messages).length, 0);
});

test("panel: dispose cancels its timers", () => {
  const { send, take, source, fileOf, clock, panel } = setUp({ s1: prompt("p1") });
  send({ type: "ready" });
  fs.appendFileSync(fileOf("s1"), use("a1", "b1", "Bash", { command: "ls" }));
  source.tick();
  take();
  panel.dispose();
  clock.advance(60_000);
  assert.deepEqual(take(), []);
});

test("panel: if the first read fails, the next line in the log recovers the session", () => {
  const env = setUp({ s1: prompt("p1") });
  const read = env.source.read.bind(env.source);
  env.source.read = () => {
    throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
  };
  env.send({ type: "ready" });
  const [failed] = snapshotsIn(env.take());
  assert.equal(failed.type === "snapshot" && failed.problem?.code, "SESSION_UNREADABLE");
  env.source.read = read;
  fs.appendFileSync(env.fileOf("s1"), text("a1", "Done."));
  env.source.tick();
  const [recovered] = snapshotsIn(env.take());
  assert.equal(recovered.type === "snapshot" && recovered.problem, null);
  assert.deepEqual(recovered.type === "snapshot" && recovered.exchanges.map((e) => e.id), ["p1"]);
});

test("panel: a log that shrinks is reported, then rebuilt from its start", () => {
  const { send, take, source, fileOf } = setUp({ s1: prompt("p1") + text("a1", "Long reply that will vanish.") });
  send({ type: "ready" });
  take();
  fs.writeFileSync(fileOf("s1"), "");
  source.tick();
  const [shrunk] = snapshotsIn(take());
  assert.equal(shrunk.type === "snapshot" && shrunk.problem?.code, "SESSION_UNREADABLE");
  fs.writeFileSync(fileOf("s1"), prompt("q1"));
  source.tick();
  const [rebuilt] = snapshotsIn(take());
  assert.deepEqual(rebuilt.type === "snapshot" && [rebuilt.problem, rebuilt.exchanges.map((e) => e.id)], [null, ["q1"]]);
});

test("panel: a log this version can't read stays a problem across a reload", () => {
  const unknown = Array.from({ length: 60 }, (_, i) => line({ type: "future-kind", n: i })).join("");
  const { send, take, source, fileOf } = setUp({ s1: "" });
  send({ type: "ready" });
  fs.writeFileSync(fileOf("s1"), unknown);
  source.tick();
  take();
  send({ type: "ready" });
  const [snapshot] = snapshotsIn(take());
  assert.equal(snapshot.type === "snapshot" && snapshot.problem?.code, "LOG_FORMAT_UNRECOGNIZED");
});

test("panel: an unreadable ledger becomes a problem, and nothing is thrown", () => {
  const { send, take, ledger, panel } = setUp({ s1: prompt("p1") });
  send({ type: "ready" });
  take();
  ledger.currentBranch = () => {
    throw Object.assign(new Error("EBUSY: HEAD"), { code: "EBUSY" });
  };
  assert.doesNotThrow(() => panel.ledgerChanged());
  const [snapshot] = snapshotsIn(take());
  assert.equal(snapshot.type === "snapshot" && snapshot.problem?.code, "LEDGER_UNREADABLE");
});

test("panel: turning watching on later processes the chat the panel follows (D-020)", () => {
  const { panel, status, used, fileOf } = setUp({ s1: prompt("p1") }, { enabled: false });
  used.length = 0;
  status.enabled = true;
  panel.ledgerChanged();
  assert.deepEqual(used, [fileOf("s1")]);
});

test("panel: Switch session pins the picked session and shows it", async () => {
  const { send, take, settle, follower } = setUp({ s1: prompt("p1"), s2: prompt("q1") }, { pick: "s1" });
  send({ type: "ready" });
  take();
  send({ type: "chooseSession", requestId: "r1" });
  await settle();
  const messages = take();
  assert.equal(follower.mode, "pinned");
  assert.equal(snapshotsIn(messages)[0]?.type === "snapshot" && (snapshotsIn(messages)[0] as { session: { id: string; following: string } }).session.following, "pinned");
  assert.ok(messages.some((m) => m.type === "actionResult" && m.ok));
});
