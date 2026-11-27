import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Ledger } from "../src/core";
import { createSessionLogSource, parseLogLines, type PollingSessionLogSource } from "../src/claude-log";
import { appendTurns, toRawTurns } from "../src/watcher/turns";
import { ExtractionPipeline } from "../src/watcher/pipeline";
import { readWatchState, writeWatchState } from "../src/watcher/offsets";
import type { ExtractionStatus } from "../src/watcher/status";
import { FIRST_RETRY_DELAY_MS } from "../src/core/backoff";
import type { Model } from "../engine/src";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-watch-"));
const turnsOf = (lines: string[], startOffset = 0) => toRawTurns(parseLogLines(lines, startOffset));

// ---------- log entries → turns (moved from the transcript tests, same expectations) ----------

test("turns: Claude Code JSONL to turns, code dropped", () => {
  const lines = [
    JSON.stringify({ type: "user", sessionId: "S", uuid: "u1", message: { role: "user", content: "Add caching with Redis" } }),
    JSON.stringify({
      type: "assistant", sessionId: "S", uuid: "a1",
      message: { content: [{ type: "text", text: "I'll use Redis with a 5 min TTL." }, { type: "tool_use", name: "Edit", input: { file_path: "/x/cache.ts", new_string: "CODE" } }] },
    }),
    JSON.stringify({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "Done." }] } }),
    "not json",
  ];
  const t = turnsOf(lines);
  assert.equal(t.length, 2);
  assert.equal(t[0].author, "human");
  assert.ok(t[1].text.includes("[Edit cache.ts]"));
  assert.ok(!t[1].text.includes("CODE"));
  assert.ok(t[1].text.includes("Done."));
});

test("turns: AI turns carry the model name from the log; human turns have none (the watcher supplies it)", () => {
  const lines = [
    JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", model: "spoofed", content: "Use tabs" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Switching to tabs." }] } }),
  ];
  const [human, ai] = turnsOf(lines);
  assert.equal(human.name, undefined);
  assert.equal(ai.name, "claude-opus-5-5");
});

test("turns: Claude Code's own <synthetic> notices are not AI turns; merged AI turns keep the first known model", () => {
  const assistant = (model: string | undefined, text: string) => JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text }] } });
  const lines = [
    JSON.stringify({ type: "user", message: { content: "Go" } }),
    assistant(undefined, "Looking."),
    assistant("claude-opus-5-5", "Using Redis."),
    assistant("<synthetic>", "You've hit your limit"),
  ];
  const turns = turnsOf(lines);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].name, "claude-opus-5-5");
  assert.ok(!turns[1].text.includes("limit"));
});

test("turns: harness messages are not attributed to the human", () => {
  const user = (uuid: string, content: unknown, origin?: unknown) =>
    JSON.stringify({ type: "user", sessionId: "S", uuid, origin, message: { role: "user", content } });
  const lines = [
    user("u1", "Use SQLite for now", { kind: "human" }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Starting a subagent." }] } }),
    user("n1", "<task-notification>Agent finished: picked Postgres</task-notification>", { kind: "task-notification" }),
    user("n2", "<task-notification>Legacy log, no origin tag</task-notification>"),
    user("i1", [{ type: "text", text: "[Request interrupted by user]" }]),
    user("c1", "<command-name>/clear</command-name>"),
    user("h2", [
      { type: "text", text: "<ide_opened_file>The user opened db.ts</ide_opened_file>" },
      { type: "text", text: "Keep the schema flat" },
      { type: "text", text: "<system-reminder>Be concise.</system-reminder>" },
    ], { kind: "human" }),
    user("h3", "<ide_selection>const x = 1;</ide_selection>\nMake this async", { kind: "human" }),
    JSON.stringify({
      type: "user", uuid: "s1", isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { content: "This session is being continued from a previous conversation. We chose Postgres." },
    }),
  ];
  assert.deepEqual(
    turnsOf(lines).map((x) => [x.author, x.text]),
    [
      ["human", "Use SQLite for now"],
      ["ai", "Starting a subagent."],
      ["human", "Keep the schema flat"],
      ["human", "Make this async"],
    ]
  );
});

test("turns: AI fragments merge the same way whether read in one go or across reads", () => {
  // Fixed timestamps: a line without one is stamped with the time it was read.
  const at = "2026-11-27T10:00:00Z";
  const ai = (uuid: string, text: string) => JSON.stringify({ type: "assistant", uuid, timestamp: at, message: { content: [{ type: "text", text }] } });
  const lines = [JSON.stringify({ type: "user", uuid: "u1", timestamp: at, message: { content: "Plan it" } }), ai("a1", "Part one."), ai("a2", "Part two.")];
  const inOneRead = turnsOf(lines);
  const acrossReads = turnsOf(lines.slice(0, 2));
  const secondStart = lines.slice(0, 2).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  appendTurns(acrossReads, turnsOf(lines.slice(2), secondStart));
  assert.deepEqual(acrossReads, inOneRead);
  assert.equal(inOneRead.length, 2);
  assert.equal(inOneRead[1].text, "Part one.\nPart two.");
});

test("turns: each turn records the byte offset after its last line", () => {
  const lines = [
    JSON.stringify({ type: "user", uuid: "u1", message: { content: "Use café-style names" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "One." }] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "Two." }] } }),
    "",
  ];
  const ends = lines.slice(0, 3).reduce<number[]>((acc, l) => [...acc, (acc.at(-1) ?? 100) + Buffer.byteLength(l) + 1], []);
  assert.deepEqual(turnsOf(lines, 100).map((t) => t.endOffset), [ends[0], ends[2]]); // merged AI turn ends after its last fragment
});

test("turns: tool notes name the file or the command's purpose; API errors and tool results make no turn", () => {
  const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", uuid: "a", message: { model: "m", content } });
  const lines = [
    JSON.stringify({ type: "user", uuid: "u", message: { content: "Go" } }),
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm i", description: "install deps" } }]),
    assistant([{ type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: [] } }]),
    assistant([{ type: "tool_use", id: "t3", name: "Grep", input: { pattern: "secret_regex", path: "/x/src" } }]),
    JSON.stringify({ type: "assistant", uuid: "e", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } }),
  ];
  assert.deepEqual(turnsOf(lines).map((t) => t.text), ["Go", "[ran: install deps]\n[Grep src]"]);
});

// ---------- the pipeline ----------

const NOW = Date.parse("2026-11-27T10:00:00Z");
const IDLE_MS = 60_000;

/** One decision per turn sent, worded from the turn's text. */
const decideEveryTurn: Model = async (_system, user) => {
  const sent = [...user.matchAll(/<turn id="(\w+)" author="\w+" name="[^"]*">\n(.*)\n/g)];
  return JSON.stringify({ decisions: sent.map(([, id, text]) => ({ decision: `Decided: ${text}`, turn: id })) });
};

let uuidCounter = 0;
const prompt = (text: string) => JSON.stringify({ type: "user", uuid: `p${++uuidCounter}`, sessionId: "S", timestamp: "2026-11-27T10:00:00Z", message: { content: text } }) + "\n";
const reply = (text: string, stop: string | null = "end_turn") =>
  JSON.stringify({ type: "assistant", uuid: `a${++uuidCounter}`, sessionId: "S", timestamp: "2026-11-27T10:00:01Z", message: { model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: stop } }) + "\n";

interface Harness {
  pipeline: ExtractionPipeline;
  source: PollingSessionLogSource;
  ledger: Ledger;
  dir: string;
  calls: string[];
  clock: { now: number };
  log: string[];
}

function harness(options: { model?: Model; before?: (h: { dir: string; ledger: Ledger }) => void } = {}): Harness {
  const workspace = path.join(tmp(), "proj");
  const projectsDir = tmp();
  const dir = path.join(projectsDir, path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir);
  const ledger = Ledger.open(tmp());
  options.before?.({ dir, ledger });
  const source = createSessionLogSource({ projectsDir, workspace, pollMs: 1000, polling: "manual" });
  const calls: string[] = [];
  const clock = { now: NOW };
  const log: string[] = [];
  const model = options.model ?? decideEveryTurn;
  const pipeline = new ExtractionPipeline({
    ledger: () => ledger,
    source,
    model: async () => async (system, user) => (calls.push(user), model(system, user)),
    humanName: () => "Priya",
    idleMs: () => IDLE_MS,
    checkEveryMs: 0,
    log: (line) => log.push(line),
    onCommitted: () => {},
    onFailure: () => {},
    onRecovered: () => {},
    now: () => clock.now,
  });
  return { pipeline, source, ledger, dir, calls, clock, log };
}

/** Lets queued flushes finish. */
async function settle(pipeline: ExtractionPipeline): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  await pipeline.checkNow();
}

const decisions = (ledger: Ledger) => ledger.stateAt().map((r) => r.record.decision);

test("pipeline: a session file created after start has its first prompt extracted", async () => {
  const h = harness();
  h.pipeline.start();
  const file = path.join(h.dir, "new.jsonl");
  fs.writeFileSync(file, prompt("Use Postgres for users") + reply("Postgres it is."));
  h.source.tick();
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), ["Decided: Use Postgres for users", "Decided: Postgres it is."]);
  assert.equal(h.pipeline.status(file).committedOffset, fs.statSync(file).size);
  const humanTurn = h.ledger.turn(h.ledger.stateAt()[0].record.source.turn);
  assert.equal(humanTurn.externalId, `p${uuidCounter - 1}`);
});

test("pipeline: a finished reply is extracted at once; an unfinished one waits for the file to go quiet", async () => {
  const h = harness();
  h.pipeline.start();
  const file = path.join(h.dir, "s.jsonl");
  fs.writeFileSync(file, prompt("Add rate limiting") + reply("Looking at the router.", "tool_use"));
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.calls.length, 0);
  assert.equal(h.pipeline.status(file).committedOffset, 0);

  fs.appendFileSync(file, reply("Token bucket, 100 requests a minute."));
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.calls.length, 1);
  assert.equal(h.pipeline.status(file).committedOffset, fs.statSync(file).size);

  fs.appendFileSync(file, prompt("Also log the rejections"));
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.calls.length, 1);
  h.clock.now += IDLE_MS;
  await h.pipeline.checkNow();
  assert.equal(h.calls.length, 2);
});

test("pipeline: status moves through in flight, failure with a retry time, and committed; retryNow runs at once", async () => {
  let failing = true;
  const h = harness({ model: async (s, u) => (failing ? Promise.reject(new Error("quota exceeded")) : decideEveryTurn(s, u)) });
  const seen: ExtractionStatus[] = [];
  h.pipeline.onDidChangeStatus((file) => seen.push(h.pipeline.status(file)));
  h.pipeline.start();
  const file = path.join(h.dir, "s.jsonl");
  fs.writeFileSync(file, prompt("Cache sessions") + reply("Redis, 5 minutes."));
  h.source.tick();
  await settle(h.pipeline);

  assert.ok(seen.some((s) => s.inFlight !== null && s.failure === null));
  const failed = h.pipeline.status(file);
  assert.equal(failed.committedOffset, 0);
  assert.equal(failed.inFlight, null);
  assert.equal((failed.failure!.error as Error).message, "quota exceeded");
  assert.equal(failed.failure!.retryAt, NOW + FIRST_RETRY_DELAY_MS);
  assert.ok(h.log.some((l) => l.includes("quota exceeded")));

  failing = false;
  h.pipeline.retryNow();
  await settle(h.pipeline);
  const done = h.pipeline.status(file);
  assert.deepEqual([done.failure, done.inFlight, done.committedOffset], [null, null, fs.statSync(file).size]);
  assert.equal(decisions(h.ledger).length, 2);
});

test("pipeline D-020: a chat with earlier history is extracted from its first message, oldest first, once it gets a new line", async () => {
  let file = "";
  const h = harness({
    before: ({ dir }) => {
      file = path.join(dir, "old.jsonl");
      fs.writeFileSync(file, prompt("Use SQLite") + reply("SQLite for now.") + prompt("Add an index") + reply("Indexed by email."));
    },
  });
  h.pipeline.start();
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.calls.length, 0);

  fs.appendFileSync(file, prompt("Move to Postgres") + reply("Postgres now."));
  h.source.tick();
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), [
    "Decided: Use SQLite",
    "Decided: SQLite for now.",
    "Decided: Add an index",
    "Decided: Indexed by email.",
    "Decided: Move to Postgres",
    "Decided: Postgres now.",
  ]);
  assert.equal(readWatchState(h.ledger)[file].offset, fs.statSync(file).size);
});

test("pipeline D-020: a dormant session that never changes is never sent", async () => {
  let file = "";
  const h = harness({
    before: ({ dir }) => {
      file = path.join(dir, "dormant.jsonl");
      fs.writeFileSync(file, prompt("Use SQLite") + reply("SQLite for now."));
    },
  });
  h.pipeline.start();
  for (let i = 0; i < 3; i++) h.source.tick();
  h.clock.now += 10 * IDLE_MS;
  await settle(h.pipeline);
  assert.equal(h.calls.length, 0);
  assert.equal(readWatchState(h.ledger)[file], undefined);
});

test("pipeline: a tracked chat that grew while the extension was off is caught up at start", async () => {
  let file = "";
  const firstExchange = prompt("Use SQLite") + reply("SQLite for now.");
  const h = harness({
    before: ({ dir, ledger }) => {
      file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, firstExchange + prompt("Add an index") + reply("Indexed by email."));
      writeWatchState(ledger, { [file]: { offset: Buffer.byteLength(firstExchange) } });
    },
  });
  h.pipeline.start();
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), ["Decided: Add an index", "Decided: Indexed by email."]);
});

test("pipeline D-020: following a chat in the panel processes it from its first message", async () => {
  let file = "";
  const h = harness({
    before: ({ dir }) => {
      file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, prompt("Use SQLite") + reply("SQLite for now."));
    },
  });
  h.pipeline.start();
  h.pipeline.useSession(file);
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), ["Decided: Use SQLite", "Decided: SQLite for now."]);
});

test("pipeline: stopping releases the source and stops extracting", async () => {
  const h = harness();
  h.pipeline.start();
  assert.equal(h.source.isPolling, true);
  h.pipeline.stop();
  assert.equal(h.source.isPolling, false);
  assert.equal(h.pipeline.status("any").enabled, false);
  fs.writeFileSync(path.join(h.dir, "s.jsonl"), prompt("Use Postgres") + reply("Done."));
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.calls.length, 0);
});

/** Whether `text` was sent as a turn (it also appears in the prompt's list of decisions so far). */
const sentAsTurn = (sent: string, text: string) => sent.includes(`">
${text}
`);

/** A model whose first call waits until `release()`; later calls answer at once. */
function blockedFirstCall(): { model: Model; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  return { model: async (s, u) => (++calls === 1 && (await gate), decideEveryTurn(s, u)), release };
}

test("pipeline: lines that arrive during a flush are extracted next, once", async () => {
  const blocked = blockedFirstCall();
  const h = harness({ model: blocked.model });
  h.pipeline.start();
  const file = path.join(h.dir, "s.jsonl");
  fs.writeFileSync(file, prompt("Use Postgres") + reply("Postgres."));
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.pipeline.status(file).inFlight !== null, true);
  fs.appendFileSync(file, prompt("Add a cache") + reply("Redis."));
  h.source.tick();
  blocked.release();
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), ["Decided: Use Postgres", "Decided: Postgres.", "Decided: Add a cache", "Decided: Redis."]);
  assert.equal(h.calls.length, 2);
});

test("pipeline: stopping and starting during a flush doesn't send the same turns twice", async () => {
  const blocked = blockedFirstCall();
  const h = harness({ model: blocked.model });
  h.pipeline.start();
  const file = path.join(h.dir, "s.jsonl");
  fs.writeFileSync(file, prompt("Use Postgres") + reply("Postgres."));
  h.source.tick();
  await settle(h.pipeline);
  h.pipeline.stop();
  h.pipeline.start();
  fs.appendFileSync(file, prompt("Add a cache") + reply("Redis."));
  h.source.tick();
  blocked.release();
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), ["Decided: Use Postgres", "Decided: Postgres.", "Decided: Add a cache", "Decided: Redis."]);
  assert.ok(!h.calls.slice(1).some((c) => sentAsTurn(c, "Use Postgres")));
});

test("pipeline: a large backlog is extracted without waiting for the reply to end", async () => {
  const h = harness();
  h.pipeline.start();
  const lines = Array.from({ length: 12 }, (_, i) => prompt(`Step ${i}`) + reply(`Working on step ${i}.`, "tool_use")).join("");
  fs.writeFileSync(path.join(h.dir, "s.jsonl"), lines);
  h.source.tick();
  await settle(h.pipeline);
  assert.equal(h.calls.length, 1);
  assert.equal(decisions(h.ledger).length, 24);
});

test("pipeline A13: a resumed session that repeats earlier history adds only what's new", async () => {
  const h = harness();
  h.pipeline.start();
  const history = prompt("Use SQLite") + reply("SQLite for now.");
  fs.writeFileSync(path.join(h.dir, "first.jsonl"), history);
  h.source.tick();
  await settle(h.pipeline);
  fs.writeFileSync(path.join(h.dir, "resumed.jsonl"), history + prompt("Move to Postgres") + reply("Postgres now."));
  h.source.tick();
  await settle(h.pipeline);
  assert.deepEqual(decisions(h.ledger), ["Decided: Use SQLite", "Decided: SQLite for now.", "Decided: Move to Postgres", "Decided: Postgres now."]);
  assert.ok(!sentAsTurn(h.calls[1], "Use SQLite"));
});

test("pipeline rule 6: nothing sent to the model from any fixture carries code, file contents, tool output or folder paths", async () => {
  const fixtures = path.join(__dirname, "..", "..", "test", "fixtures", "claude-log");
  const h = harness();
  h.pipeline.start();
  for (const name of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, name), path.join(h.dir, name));
  h.source.tick();
  h.clock.now += IDLE_MS;
  await settle(h.pipeline);
  assert.ok(h.calls.length > 0);
  for (const sent of h.calls) {
    assert.ok(!sent.includes("SECRET_"), sent.match(/SECRET_\w+/)?.[0]);
    assert.ok(!sent.includes("/work/proj"), "a folder path reached the model");
  }
  assert.ok(h.calls.some((c) => c.includes("[Edit db.ts]")));
});
