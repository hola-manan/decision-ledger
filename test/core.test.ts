import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Ledger } from "../src/core/store";
import { stripCode, splitCode, parseDecisions, extractDecisions } from "../src/core/engine";
import { ingest } from "../src/core/ingest";
import { parseClaudeCodeLines, findSessionFiles } from "../src/core/transcript";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));

test("stripCode removes fenced code, keeps prose", () => {
  const t = "Use Postgres.\n```ts\nconst x = 1;\n```\nThen add an index.";
  assert.equal(stripCode(t), "Use Postgres.\n[code omitted]\nThen add an index.");
  const parts = splitCode(t);
  assert.deepEqual(parts.map((p) => p.kind), ["prose", "code", "prose"]);
  assert.ok(parts[1].text.includes("const x = 1;"));
});

test("store: ordered records, nodes form a chain, state accumulates", () => {
  const l = Ledger.open(tmp());
  const turn = l.addTurn({ author: "human", text: "use postgres", session: "s", origin: "t", timestamp: "x" });
  const a = l.commit([{ decision: "Use Postgres", author: "human", turn }], { message: "one", origin: "t" })!;
  const b = l.commit(
    [
      { decision: "Add index on email", author: "ai", turn },
      { decision: "Use UUID keys", author: "ai", turn },
    ],
    { message: "two", origin: "t" }
  )!;
  assert.deepEqual(l.stateAt().map((r) => r.record.seq), [1, 2, 3]);
  assert.equal(l.log().length, 2);
  assert.equal(l.log()[0].node.parent, a.node);
  assert.deepEqual(l.stateAt(a.node).map((r) => r.record.decision), ["Use Postgres"]);
  assert.deepEqual(l.diff(a.node, b.node).added, b.records);
});

test("store: supersedes hides old decision from active state", () => {
  const l = Ledger.open(tmp());
  const turn = l.addTurn({ author: "human", text: "x", session: "s", origin: "t", timestamp: "x" });
  const a = l.commit([{ decision: "Use MySQL", author: "human", turn }], { message: "a", origin: "t" })!;
  l.commit([{ decision: "Use Postgres", author: "human", turn, supersedes: a.records[0] }], { message: "b", origin: "t" });
  assert.deepEqual(l.activeAt().map((r) => r.record.decision), ["Use Postgres"]);
  assert.equal(l.stateAt().length, 2);
});

test("store: branches fork the tree", () => {
  const l = Ledger.open(tmp());
  const turn = l.addTurn({ author: "ai", text: "x", session: "s", origin: "t", timestamp: "x" });
  const a = l.commit([{ decision: "A", author: "ai", turn }], { message: "a", origin: "t" })!;
  l.commit([{ decision: "B", author: "ai", turn }], { message: "b", origin: "t" });
  l.createBranch("experiment", a.node);
  l.checkout("experiment");
  l.commit([{ decision: "C", author: "ai", turn }], { message: "c", origin: "t" });
  assert.deepEqual(l.stateAt().map((r) => [r.record.seq, r.record.decision]), [[1, "A"], [2, "C"]]);
  l.checkout("main");
  assert.deepEqual(l.stateAt().map((r) => r.record.decision), ["A", "B"]);
  assert.equal(l.branches().length, 2);
});

test("parseDecisions grounds to real turns and verifies quotes", () => {
  const turns = [
    { id: "aaaaaaaaaaaa1", author: "human" as const, text: "Let's not support IE11 at all." },
    { id: "bbbbbbbbbbbb2", author: "ai" as const, text: "I'll use Vite for the build since it's faster." },
  ];
  const raw = `Here you go:\n{"decisions":[
    {"decision":"Drop IE11 support","author":"human","turn":"aaaaaaaaaa","quote":"not support IE11 at all"},
    {"decision":"Build with Vite","rationale":"faster","author":"human","turn":"bbbbbbbbbb","quote":"made up words"}
  ]}`;
  const out = parseDecisions(raw, turns, []);
  assert.equal(out.length, 2);
  assert.equal(out[0].quote, "not support IE11 at all");
  assert.equal(out[1].author, "ai", "author follows the grounding turn");
  assert.equal(out[1].quote, undefined, "unverifiable quote dropped");
});

test("engine never sends code to the model", async () => {
  let seen = "";
  await extractDecisions(
    [{ id: "t1", author: "ai", text: "Switching to SQLite.\n```js\nSECRET_CODE()\n```" }],
    [],
    async (_s, u) => ((seen = u), '{"decisions":[]}')
  );
  assert.ok(seen.includes("Switching to SQLite"));
  assert.ok(!seen.includes("SECRET_CODE"));
});

test("ingest: end to end with a fake model", async () => {
  const l = Ledger.open(tmp());
  const fake = async (_s: string, u: string) => {
    const id = u.match(/turn id="([0-9a-f]+)" author="human"/)![1];
    return JSON.stringify({ decisions: [{ decision: "Use tabs", author: "human", turn: id, quote: "use tabs" }] });
  };
  const r = await ingest(l, [{ author: "human", text: "Please use tabs" }, { author: "ai", text: "Done." }], fake, {
    origin: "test",
    session: "s1",
  });
  assert.ok(r);
  const [rec] = l.stateAt();
  assert.equal(rec.record.quote, "use tabs");
  assert.equal(l.get<any>(rec.record.turn).text, "Please use tabs");
});

test("transcript: Claude Code JSONL to turns, code dropped", () => {
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
  const t = parseClaudeCodeLines(lines);
  assert.equal(t.length, 2);
  assert.equal(t[0].author, "human");
  assert.ok(t[1].text.includes("[Edit cache.ts]"));
  assert.ok(!t[1].text.includes("CODE"));
  assert.ok(t[1].text.includes("Done."));
});

test("transcript: finds session files for a workspace", () => {
  const root = tmp();
  const ws = "/home/me/proj";
  const d = path.join(root, ws.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "s.jsonl"), "");
  const other = path.join(root, "weird");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "t.jsonl"), JSON.stringify({ cwd: "/home/me/proj/sub" }) + "\n");
  assert.equal(findSessionFiles(root, ws).length, 2);
});
