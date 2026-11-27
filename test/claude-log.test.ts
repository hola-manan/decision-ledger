import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createSessionLogSource,
  DRIFT_MIN_LINES,
  findSessionFiles,
  isInsideWorkspace,
  isTurnEnd,
  parseLogLines,
  type AssistantEntry,
  type LogBatch,
  type LogEntry,
  type PromptEntry,
  type ToolResultEntry,
} from "../src/claude-log";

const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "claude-log");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-log-"));
const fixturePath = (name: string) => path.join(FIXTURES, `${name}.jsonl`);
const fixtureNames = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl")).map((f) => path.basename(f, ".jsonl"));

/** Complete lines of a fixture, parsed from offset 0. */
function parseFixture(name: string): LogEntry[] {
  const text = fs.readFileSync(fixturePath(name), "utf8");
  const complete = text.slice(0, text.lastIndexOf("\n"));
  return parseLogLines(complete.split("\n"), 0);
}
const ofKind = <K extends LogEntry["kind"]>(entries: LogEntry[], kind: K) => entries.filter((e): e is Extract<LogEntry, { kind: K }> => e.kind === kind);

// ---------- parser ----------

test("parser A2: offsets are byte-exact with multibyte text, and every entry points at its own line", () => {
  const bytes = fs.readFileSync(fixturePath("prompt-and-reply"));
  const entries = parseFixture("prompt-and-reply");
  assert.ok(entries.length >= 2);
  for (const e of entries) {
    const line = JSON.parse(bytes.subarray(e.startOffset, e.endOffset).toString("utf8"));
    assert.equal(line.uuid, e.uuid);
  }
  assert.equal(entries.at(-1)!.endOffset, bytes.length);
  assert.match((entries[0] as PromptEntry).text, /café — naïve 🚀/);
});

test("parser A2: a trailing CR is ignored, malformed lines produce nothing", () => {
  const line = JSON.stringify({ type: "user", uuid: "u1", message: { content: "Use tabs" } });
  const entries = parseLogLines(["not json", line + "\r", "[1,2]", ""], 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].startOffset, 10 + "not json".length + 1);
  assert.equal(entries[0].endOffset, entries[0].startOffset + Buffer.byteLength(line + "\r") + 1);
});

test("parser A3/A4/A5: only the conversation survives; harness elements, sidechains, meta and summaries are dropped", () => {
  const entries = parseFixture("harness-and-meta");
  assert.deepEqual(entries.map((e) => e.kind), ["prompt", "assistant"]);
  const prompt = entries[0] as PromptEntry;
  assert.equal(prompt.text, "Keep the schema flat");
  assert.equal(prompt.permissionMode, "default");
  assert.equal(prompt.sessionId, "S1");
  assert.ok(!JSON.stringify(entries).includes("SECRET_"));
});

test("parser A6: one line per block with a shared message id; only the final line ends the turn", () => {
  const entries = parseFixture("multi-block-assistant");
  const assistant = ofKind(entries, "assistant");
  assert.deepEqual(assistant.map((a) => a.messageId), ["msg-1", "msg-1", "msg-2"]);
  assert.deepEqual(assistant.map((a) => a.stopReason), [undefined, "tool_use", "end_turn"]);
  assert.deepEqual(entries.map(isTurnEnd), [false, false, false, false, true]);
  assert.ok(assistant.every((a) => a.model === "claude-opus-5-5"));
});

test("parser A6: thinking keeps no content; a null stop reason is absent", () => {
  const [, thinking, reply] = parseFixture("prompt-and-reply") as AssistantEntry[];
  assert.deepEqual(thinking.blocks, [{ type: "thinking" }]);
  assert.equal("stopReason" in thinking, false);
  assert.deepEqual(reply.blocks, [{ type: "text", text: "Yes: Redis with a 5 minute TTL." }]);
});

test("parser A6: an API error is kept as apiError; other <synthetic> notices are dropped", () => {
  const entries = parseFixture("api-error");
  assert.deepEqual(entries.map((e) => e.kind), ["prompt", "assistant"]);
  const error = entries[1] as AssistantEntry;
  assert.equal(error.apiError, "API Error: 529 Overloaded");
  assert.deepEqual(error.blocks, []);
  assert.equal(error.model, undefined);
});

test("parser A7: line counts come from the result's structuredPatch; a Write create is an added file", () => {
  const results = ofKind(parseFixture("edit-write-multiedit-notebook"), "toolResult");
  const changes = Object.fromEntries(results.map((r) => [r.toolUseId, r.fileChange]));
  assert.deepEqual(changes.toolu_edit, { path: "/work/proj/src/db.ts", kind: "modified", added: 3, removed: 2 });
  assert.deepEqual(changes.toolu_write, { path: "/work/proj/src/migrate.ts", kind: "added", added: 4, removed: 0 });
  assert.deepEqual(changes.toolu_multi, { path: "/work/proj/src/user.ts", kind: "modified", added: 3, removed: 3 });
  assert.equal(changes.toolu_nb, undefined);
});

test("parser A8: tool inputs become facts; counts from the inputs are the fallback", () => {
  const calls = ofKind(parseFixture("edit-write-multiedit-notebook"), "assistant").flatMap((a) => a.blocks.flatMap((b) => (b.type === "toolUse" ? [b.call] : [])));
  const byTool = Object.fromEntries(calls.map((c) => [c.tool, c]));
  assert.deepEqual(byTool.Edit.edit, { path: "/work/proj/src/db.ts", kind: "modified", added: 3, removed: 2 });
  assert.deepEqual(byTool.MultiEdit.edit, { path: "/work/proj/src/user.ts", kind: "modified", added: 3, removed: 3 });
  assert.deepEqual(byTool.Write.edit, { path: "/work/proj/src/migrate.ts", kind: "modified", added: 4 });
  assert.deepEqual(byTool.NotebookEdit.edit, { path: "/work/proj/analysis.ipynb", kind: "modified" });
  assert.equal(byTool.Edit.target, "/work/proj/src/db.ts");

  const bash = ofKind(parseFixture("bash"), "assistant")[0].blocks[0];
  assert.deepEqual(bash, { type: "toolUse", call: { id: "toolu_bash", tool: "Bash", command: "npm test", description: "Run the test suite" } });

  const ask = ofKind(parseFixture("ask-user-question-pending"), "assistant")[1].blocks[0];
  assert.ok(ask.type === "toolUse");
  assert.deepEqual(ask.call.questions, [
    { question: "Which database should users live in?", header: "Database", options: [{ label: "Postgres", description: "Relational, what the rest uses" }, { label: "SQLite" }], multiSelect: false },
  ]);
  assert.ok(!parseFixture("ask-user-question-pending").some((e) => e.kind === "toolResult"));
});

test("parser A9/A11: a denial is a rejected error result, followed by the interrupt notice", () => {
  const entries = parseFixture("tool-denied");
  const denied = ofKind(entries, "toolResult")[0];
  assert.equal(denied.rejected, true);
  assert.equal(denied.isError, true);
  assert.equal(entries.at(-1)!.kind, "interrupt");
  assert.ok(!ofKind(entries, "prompt").some((p) => p.text.includes("interrupted")));
  assert.equal(ofKind(parseFixture("bash"), "toolResult")[0].rejected, false);
});

test("parser A10: an answered question carries its answers", () => {
  const result = ofKind(parseFixture("ask-user-question-answered"), "toolResult")[0] as ToolResultEntry;
  assert.deepEqual(result.answers, [
    { question: "Which database should users live in?", answer: "Postgres" },
    { question: "Which features?", answer: "Search, Export" },
  ]);
});

test("parser A11: stopping gives an interrupt entry and no prompt", () => {
  assert.deepEqual(parseFixture("interrupt").map((e) => e.kind), ["prompt", "assistant", "interrupt"]);
});

test("parser: a reply that ends with a plain-text question ends the turn", () => {
  const entries = parseFixture("plain-text-question");
  assert.ok(isTurnEnd(entries.at(-1)!));
});

test("parser: no entry from any fixture carries file contents, old/new strings, thinking or tool output", () => {
  for (const name of fixtureNames()) {
    const serialised = JSON.stringify(parseFixture(name));
    assert.ok(!serialised.includes("SECRET_"), `${name} leaked: ${serialised.match(/SECRET_\w+/)?.[0]}`);
  }
});

// ---------- discovery (A1) ----------

/** A projects folder whose slug matches `workspace` (A1). */
function projectsFor(workspace: string): { root: string; dir: string } {
  const root = tmp();
  const dir = path.join(root, path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir);
  return { root, dir };
}

test("discovery A1: finds session files for a workspace by folder name or recorded cwd", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  fs.writeFileSync(path.join(dir, "s.jsonl"), "");
  const other = path.join(root, "weird");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "t.jsonl"), JSON.stringify({ cwd: path.join(ws, "sub") }) + "\n");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "u.jsonl"), JSON.stringify({ cwd: ws + "-old" }) + "\n");
  assert.equal(findSessionFiles(root, ws).length, 2);
});

test("discovery A1: workspace matching handles Windows path forms and prefix collisions", () => {
  const win = (candidate: string, workspace: string) => isInsideWorkspace(candidate, workspace, "win32");
  assert.ok(win("c:\\Users\\me\\proj", "C:\\Users\\me\\proj"));
  assert.ok(win("C:\\USERS\\me\\proj\\sub", "c:\\Users\\me\\proj"));
  assert.ok(win("/c/Users/me/proj/sub", "c:\\Users\\me\\proj"));
  assert.ok(!win("c:\\Users\\me\\project", "c:\\Users\\me\\proj"));
  assert.ok(!win("d:\\Users\\me\\proj", "c:\\Users\\me\\proj"));

  const posix = (candidate: string, workspace: string) => isInsideWorkspace(candidate, workspace, "linux");
  assert.ok(posix("/home/me/proj/sub", "/home/me/proj"));
  assert.ok(!posix("/home/me/project", "/home/me/proj"));
  assert.ok(!posix("/home/me/Proj", "/home/me/proj"));
});

test("discovery: a file's head is read once across repeated scans", () => {
  const ws = path.join(tmp(), "proj");
  const root = tmp();
  const other = path.join(root, "weird");
  fs.mkdirSync(other);
  const file = path.join(other, "t.jsonl");
  fs.writeFileSync(file, JSON.stringify({ cwd: ws }) + "\n");
  const memo = new Map<string, boolean>();
  assert.equal(findSessionFiles(root, ws, memo).length, 1);
  fs.writeFileSync(file, JSON.stringify({ cwd: "/elsewhere" }) + "\n"); // a recorded cwd never changes in practice
  assert.equal(findSessionFiles(root, ws, memo).length, 1);
  assert.equal(findSessionFiles(root, ws).length, 0);
});

// ---------- the shared reader ----------

const promptLine = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, sessionId: "S", timestamp: "2026-11-27T10:00:00Z", message: { content: text } }) + "\n";

function sourceFor(projectsDir: string, workspace: string) {
  const source = createSessionLogSource({ projectsDir, workspace, pollMs: 1000, polling: "manual" });
  const batches: LogBatch[] = [];
  source.onDidAppend((b) => batches.push(b));
  return { source, batches };
}

test("source: files that existed at start begin at their last complete line; files found later begin at 0", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const old = path.join(dir, "old.jsonl");
  fs.writeFileSync(old, promptLine("o1", "Before") + '{"type":"user","half');
  const { source, batches } = sourceFor(root, ws);
  const lease = source.acquire();
  assert.equal(source.cursor(old), Buffer.byteLength(promptLine("o1", "Before")));
  assert.equal(batches.length, 0);

  const fresh = path.join(dir, "new.jsonl");
  fs.writeFileSync(fresh, promptLine("n1", "First prompt"));
  source.tick();
  assert.deepEqual(batches.map((b) => [path.basename(b.file), b.fromOffset, b.entries.map((e) => e.uuid)]), [["new.jsonl", 0, ["n1"]]]);
  assert.deepEqual(source.sessions().map((s) => [s.sessionId, s.existedAtStart]).sort(), [["new", false], ["old", true]]);
  lease.dispose();
});

test("source A2: appends carry complete lines only; the rest waits for its newline", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const { source, batches } = sourceFor(root, ws);
  source.acquire();
  const file = path.join(dir, "s.jsonl");
  fs.copyFileSync(fixturePath("partial-last-line"), file);
  source.tick();
  const text = fs.readFileSync(file, "utf8");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].toOffset, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
  assert.deepEqual(batches[0].entries.map((e) => e.kind), ["prompt"]);
  source.tick();
  assert.equal(batches.length, 1);
  fs.appendFileSync(file, "\n");
  source.tick();
  assert.equal(batches.length, 2);
});

test("source: read(0) then appends gives every entry exactly once while lines keep arriving", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, promptLine("u1", "One") + promptLine("u2", "Two"));
  const { source, batches } = sourceFor(root, ws);
  source.acquire();
  fs.appendFileSync(file, promptLine("u3", "Three"));
  const backfill = source.read(file, 0);
  fs.appendFileSync(file, promptLine("u4", "Four"));
  source.tick();
  const seen = [...backfill.entries, ...batches.flatMap((b) => b.entries)].map((e) => e.uuid);
  assert.deepEqual(seen, ["u1", "u2", "u3", "u4"]);
  assert.equal(backfill.toOffset, batches[0].fromOffset);
});

test("source: polling runs while a lease is held and stops when the last one is released", () => {
  const ws = path.join(tmp(), "proj");
  const { root } = projectsFor(ws);
  const source = createSessionLogSource({ projectsDir: root, workspace: ws, pollMs: 60_000 });
  const first = source.acquire();
  const second = source.acquire();
  first.dispose();
  first.dispose(); // releasing twice counts once
  assert.equal(source.isPolling, true);
  second.dispose();
  assert.equal(source.isPolling, false);
});

test("source: a failing file is reported and the others keep flowing; a failed scan is reported with no file", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const { source, batches } = sourceFor(root, ws);
  const failures: (string | null)[] = [];
  source.onDidFail((f) => failures.push(f.file && path.basename(f.file)));
  source.onDidAppend((b) => {
    if (b.file.endsWith("bad.jsonl")) throw new Error("subscriber failed");
  });
  source.acquire();
  fs.writeFileSync(path.join(dir, "bad.jsonl"), promptLine("b1", "Bad"));
  fs.writeFileSync(path.join(dir, "good.jsonl"), promptLine("g1", "Good"));
  source.tick();
  assert.deepEqual(failures, ["bad.jsonl"]);
  assert.deepEqual(batches.map((b) => path.basename(b.file)).sort(), ["bad.jsonl", "good.jsonl"]);

  const notADirectory = path.join(tmp(), "file");
  fs.writeFileSync(notADirectory, "");
  const broken = createSessionLogSource({ projectsDir: notADirectory, workspace: ws, pollMs: 1000, polling: "manual" });
  const scanFailures: (string | null)[] = [];
  broken.onDidFail((f) => scanFailures.push(f.file));
  broken.acquire();
  assert.deepEqual(scanFailures, [null]);
});

test("source: format drift is reported once when many lines yield nothing", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const { source } = sourceFor(root, ws);
  const drift: number[] = [];
  source.onFormatDrift((d) => drift.push(d.lines));
  source.acquire();
  fs.copyFileSync(fixturePath("unknown-types"), path.join(dir, "future.jsonl"));
  fs.copyFileSync(fixturePath("bash"), path.join(dir, "known.jsonl"));
  source.tick();
  fs.appendFileSync(path.join(dir, "future.jsonl"), '{"type":"future-entry"}\n');
  source.tick();
  assert.equal(drift.length, 1);
  assert.ok(drift[0] >= DRIFT_MIN_LINES);
});

test("source: the closely watched file is read on the live poll, others wait for the full poll", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const followed = path.join(dir, "followed.jsonl");
  const other = path.join(dir, "other.jsonl");
  fs.writeFileSync(followed, "");
  fs.writeFileSync(other, "");
  const { source, batches } = sourceFor(root, ws);
  source.acquire();
  source.watchClosely(followed);
  fs.appendFileSync(followed, promptLine("f1", "Live"));
  fs.appendFileSync(other, promptLine("o1", "Later"));
  source.tickLive();
  assert.deepEqual(batches.map((b) => b.entries[0].uuid), ["f1"]);
  source.tick();
  assert.deepEqual(batches.map((b) => b.entries[0].uuid), ["f1", "o1"]);
});

test("discovery: a file with no cwd yet is checked again on the next scan", () => {
  const ws = path.join(tmp(), "proj");
  const root = tmp();
  const other = path.join(root, "weird");
  fs.mkdirSync(other);
  const file = path.join(other, "t.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "file-history-snapshot" }) + "\n");
  const memo = new Map<string, boolean>();
  assert.equal(findSessionFiles(root, ws, memo).length, 0);
  fs.appendFileSync(file, JSON.stringify({ cwd: path.join(ws, "sub") }) + "\n");
  assert.equal(findSessionFiles(root, ws, memo).length, 1);
});

test("parser rule 6: a Bash command keeps only its first line, capped, so a heredoc body never leaves the parser", () => {
  const command = "cat > notes.py <<'EOF'\nSECRET_HEREDOC_BODY\nEOF";
  const long = "echo " + "x".repeat(500);
  const call = (cmd: string) => JSON.stringify({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: cmd } }] } });
  const [heredoc, capped] = parseLogLines([call(command), call(long)], 0) as AssistantEntry[];
  const commandOf = (e: AssistantEntry) => (e.blocks[0].type === "toolUse" ? e.blocks[0].call.command : undefined);
  assert.equal(commandOf(heredoc), "cat > notes.py <<'EOF'");
  assert.equal(commandOf(capped)!.length, 200);
  assert.ok(commandOf(capped)!.endsWith("…"));
});

test("parser A5: the origin tag decides what the person typed, never whether a tool result counts", () => {
  const result = JSON.stringify({ type: "user", uuid: "r", origin: { kind: "something-new" }, message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
  const typed = JSON.stringify({ type: "user", uuid: "p", origin: { kind: "something-new" }, message: { content: "Not typed by the person" } });
  assert.deepEqual(parseLogLines([result, typed], 0).map((e) => e.kind), ["toolResult"]);
});

test("source: a file that got shorter is reported and read again from the start", () => {
  const ws = path.join(tmp(), "proj");
  const { root, dir } = projectsFor(ws);
  const file = path.join(dir, "s.jsonl");
  const { source, batches } = sourceFor(root, ws);
  const failures: string[] = [];
  source.onDidFail((f) => failures.push(f.error.message));
  source.acquire();
  fs.writeFileSync(file, promptLine("u1", "One") + promptLine("u2", "Two"));
  source.tick();
  fs.writeFileSync(file, promptLine("u3", "Three"));
  source.tick();
  assert.equal(failures.length, 1);
  assert.match(failures[0], /got shorter/);
  source.tick();
  assert.deepEqual(batches.map((b) => b.entries.map((e) => e.uuid)), [["u1", "u2"], ["u3"]]);
});
