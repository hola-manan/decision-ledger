import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Author, Ledger, NewDecision, ParameterSet } from "../src/core/store";
import { stripCode, splitCode, asMarkdownCode } from "../src/core/code";
import { ingest, IngestMeta, parseIngestTurns } from "../src/core/ingest";
import { CONFIG_FILE, ConfigError, DEFAULT_PARAMETERS, loadParameters } from "../src/core/parameters";
import { appendTurns } from "../src/watcher/turns";
import { chunkTurns, splitText } from "../src/core/chunk";
import { batchSize, ingestBacklog } from "../src/core/batches";
import { InvalidInputError, type Model } from "../engine/src";
import { RetryBackoff, FIRST_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS } from "../src/core/backoff";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));

test("stripCode removes fenced code, keeps prose", () => {
  const t = "Use Postgres.\n```ts\nconst x = 1;\n```\nThen add an index.";
  assert.equal(stripCode(t), "Use Postgres.\n[code omitted]\nThen add an index.");
  const parts = splitCode(t);
  assert.deepEqual(parts.map((p) => p.kind), ["prose", "code", "prose"]);
  assert.ok(parts[1].text.includes("const x = 1;"));
});

test("stripCode removes unfenced pasted code, keeps prose around it", () => {
  const paste = [
    "Here's my current config, keep it but switch to Postgres.",
    "import { db } from './db';",
    "",
    "export const config = {",
    "  host: 'localhost',",
    "  retries: 3,",
    "};",
    "Also drop the retries.",
  ].join("\n");
  assert.equal(
    stripCode(paste),
    "Here's my current config, keep it but switch to Postgres.\n[code omitted]\nAlso drop the retries."
  );
  const code = splitCode(paste).filter((s) => s.kind === "code");
  assert.equal(code.length, 1);
  assert.ok(code[0].text.startsWith("import { db }") && code[0].text.endsWith("};"));
});

test("stripCode leaves prose alone even with code-ish punctuation", () => {
  const prose = [
    "We decided two things; both are final.",
    "First, use Postgres (not SQLite).",
    "- Keep the schema flat",
    "- Add an index on user_id",
    "Each card shows:",
    "- the product name, brand and price;",
    "- \"why it's for you\", tied to your saves;",
    "- `/api/...` paths with no `/v1`;",
    "1. retries (max 3);",
    "Status: done.",
  ].join("\n");
  assert.equal(stripCode(prose), prose);
});

test("stripCode keeps lowercase chat prose, including lists and lines ending in ':'", () => {
  const prose = [
    "for the api:",
    "  - use rest, no graphql",
    "if auth is needed:",
    "  - use jwt",
    "with that in mind:",
    "let's also add logging (pino)",
  ].join("\n");
  assert.equal(stripCode(prose), prose);
});

test("stripCode keeps prose that merely starts like code: '/*', '-   ' lists, all-caps SQL words", () => {
  const cases = [
    ["Quick notes", "/* not sure about this yet", "We'll use Postgres for storage.", "We will not add Redis.", "Ship on Friday."],
    ["/*.log files and build output", "should be ignored by git.", "We agreed on that."],
    ["Decisions:", "-   use postgres;", "-   drop redis;", "-   keep the api flat;", "That's all."],
    ["FROM now on we use Postgres.", "SET the default timeout to 5s.", "DROP the Redis cache entirely."],
  ];
  for (const lines of cases) assert.equal(stripCode(lines.join("\n")), lines.join("\n"));
});

test("stripCode removes unfenced diffs, markup, SQL and trailing indented code", () => {
  const cases = [
    ["diff --git a/x.ts b/x.ts", "@@ -1,3 +1,3 @@", "   const a = 1;", "-  const retries = 3;", "+  const retries = 5;", "+  return secret"],
    ['<div class="card">', '  <h2 class="title">Hi</h2>', "  <p>{body}</p>", "</div>"],
    ["SELECT id, name", "FROM users", "WHERE active = true", "ORDER BY name;"],
    ["x = 1", "y = 2", "def f():", "    return compute_total", "    secret_logic_here"],
    ["/**", " * Store layout:", " * - turn : one chat message", " */", "export class Ledger {", "}"],
  ];
  for (const lines of cases) {
    assert.equal(stripCode(`Look at this:\n${lines.join("\n")}\nThoughts?`), "Look at this:\n[code omitted]\nThoughts?");
  }
});

test("asMarkdownCode wraps unfenced code in a fence it can't close early", () => {
  assert.equal(asMarkdownCode("```ts\nx\n```"), "```ts\nx\n```");
  assert.equal(asMarkdownCode("a = 1\n  ```\nb = 2"), "````\na = 1\n  ```\nb = 2\n````");
});

const priya: Author = { kind: "human", name: "Priya" };
const claude: Author = { kind: "ai", name: "claude-opus-5-5" };
const meta = (more: Partial<IngestMeta> = {}): IngestMeta => ({ origin: "test", session: "s", humanName: "Priya", ...more });

/** A stored turn and a record shape for it; each test changes only what it's about. */
function newDecision(l: Ledger, decision: string, more: Partial<NewDecision> = {}): NewDecision {
  const turn = l.addTurn({ author: priya, text: decision, session: "s", origin: "t", timestamp: "x" });
  return { decision, author: priya, source: { turn }, grades: {}, ...more };
}

test("store: ordered records, nodes form a chain, state accumulates", () => {
  const l = Ledger.open(tmp());
  const a = l.commit([newDecision(l, "Use Postgres")], { message: "one", origin: "t" })!;
  const b = l.commit([newDecision(l, "Add index on email"), newDecision(l, "Use UUID keys")], { message: "two", origin: "t" })!;
  assert.deepEqual(l.stateAt().map((r) => r.record.seq), [1, 2, 3]);
  assert.equal(l.log().length, 2);
  assert.equal(l.log()[0].node.parent, a.node);
  assert.deepEqual(l.stateAt(a.node).map((r) => r.record.decision), ["Use Postgres"]);
  assert.deepEqual(l.diff(a.node, b.node).added, b.records);
});

test("store: a record holds the decision, its source, its grades and its author", () => {
  const l = Ledger.open(tmp());
  const parameterSet = l.addParameterSet(DEFAULT_PARAMETERS);
  const d = newDecision(l, "Use Postgres", { author: claude, grades: { codeSpan: 4, reversibility: 2 }, parameterSet });
  d.source.quote = "Use Postgres";
  const { records } = l.commit([d], { message: "m", origin: "t" })!;
  const stored = l.record(records[0]);
  assert.deepEqual(
    { decision: stored.decision, source: stored.source, grades: stored.grades, author: stored.author },
    { decision: "Use Postgres", source: d.source, grades: { codeSpan: 4, reversibility: 2 }, author: claude }
  );
  assert.deepEqual(l.get<ParameterSet>(stored.parameterSet!).parameters, DEFAULT_PARAMETERS);
  assert.equal(l.addParameterSet(DEFAULT_PARAMETERS), parameterSet, "the same set is stored once");
});

test("store: records and turns written by v0.1 read in today's shape", () => {
  const l = Ledger.open(tmp());
  const turn = l.put({ type: "turn", author: "human", text: "Use tabs", session: "s", origin: "t", timestamp: "x" } as any);
  const old = l.put({ type: "record", seq: 1, decision: "Use tabs", author: "human", turn, quote: "Use tabs", timestamp: "x" } as any);
  assert.deepEqual(l.record(old).author, { kind: "human", name: "human" });
  assert.deepEqual(l.record(old).source, { turn, quote: "Use tabs" });
  assert.deepEqual(l.record(old).grades, {});
  assert.deepEqual(l.turn(turn).author, { kind: "human", name: "human" });
});

test("store: supersedes hides old decision from active state", () => {
  const l = Ledger.open(tmp());
  const a = l.commit([newDecision(l, "Use MySQL")], { message: "a", origin: "t" })!;
  l.commit([newDecision(l, "Use Postgres", { supersedes: a.records[0] })], { message: "b", origin: "t" });
  assert.deepEqual(l.activeAt().map((r) => r.record.decision), ["Use Postgres"]);
  assert.equal(l.stateAt().length, 2);
});

test("store: branches fork the tree", () => {
  const l = Ledger.open(tmp());
  const a = l.commit([newDecision(l, "A")], { message: "a", origin: "t" })!;
  l.commit([newDecision(l, "B")], { message: "b", origin: "t" });
  l.createBranch("experiment", a.node);
  l.checkout("experiment");
  l.commit([newDecision(l, "C")], { message: "c", origin: "t" });
  assert.deepEqual(l.stateAt().map((r) => [r.record.seq, r.record.decision]), [[1, "A"], [2, "C"]]);
  l.checkout("main");
  assert.deepEqual(l.stateAt().map((r) => r.record.decision), ["A", "B"]);
  assert.equal(l.branches().length, 2);
});

test("parameters: config.json is created with the defaults, and edits to it are used", () => {
  const l = Ledger.open(tmp());
  assert.deepEqual(loadParameters(l), DEFAULT_PARAMETERS);
  const file = path.join(l.dir, CONFIG_FILE);
  const mine = [{ id: "risk", name: "Risk", low: "harmless", high: "could sink the project" }];
  fs.writeFileSync(file, JSON.stringify({ parameters: mine }));
  assert.deepEqual(loadParameters(l), mine);
});

test("parameters: a broken config.json is a ConfigError naming the file, never silently replaced", () => {
  const l = Ledger.open(tmp());
  const file = path.join(l.dir, CONFIG_FILE);
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => loadParameters(l), (e: Error) => e instanceof ConfigError && /config\.json is not valid JSON/.test(e.message));
  const broken = JSON.stringify({ parameters: [{ id: "risk" }] });
  fs.writeFileSync(file, broken);
  assert.throws(() => loadParameters(l), (e: Error) => e instanceof ConfigError && /\.ledger\/config\.json parameters\[0\]\.name: expected a string/.test(e.message));
  assert.equal(fs.readFileSync(file, "utf8"), broken);
});

test("ingest never sends code to the model, and never stores it", async () => {
  const l = Ledger.open(tmp());
  let seen = "";
  const model: Model = async (_s, u) => ((seen = u), '{"decisions":[{"decision":"Use SQLite","turn":"1"}]}');
  await ingest(l, [{ author: "ai", text: "Switching to SQLite.\n```js\nSECRET_CODE()\n```" }], model, meta());
  assert.ok(seen.includes("Switching to SQLite"));
  assert.ok(!seen.includes("SECRET_CODE"));
  const [rec] = l.stateAt();
  assert.ok(!l.turn(rec.record.source.turn).text.includes("SECRET_CODE"));
});

test("ingest: end to end, the record carries source, grades against the config, and the author's name", async () => {
  const l = Ledger.open(tmp());
  let prompt = "";
  const fake: Model = async (_s, u) => {
    prompt = u;
    const id = u.match(/turn id="(\w+)" author="human"/)![1];
    return JSON.stringify({ decisions: [{ decision: "Use tabs", turn: id, quote: "use tabs", grades: { codeSpan: 5, reversibility: 4 } }] });
  };
  const turns = [
    { author: "human" as const, text: "Please use tabs" },
    { author: "ai" as const, name: "gemini-3.8-flash", text: "Done." },
  ];
  assert.ok(await ingest(l, turns, fake, meta()));
  const [rec] = l.stateAt();
  assert.equal(rec.record.source.quote, "use tabs");
  assert.equal(l.turn(rec.record.source.turn).text, "Please use tabs");
  assert.deepEqual(rec.record.author, { kind: "human", name: "Priya" });
  assert.deepEqual(rec.record.grades, { codeSpan: 5, reversibility: 4 });
  assert.deepEqual(l.get<ParameterSet>(rec.record.parameterSet!).parameters, DEFAULT_PARAMETERS);
  assert.match(prompt, /PARAMETERS:\n- codeSpan \(Code span\)/);
  assert.match(prompt, /author="ai" name="gemini-3\.8-flash"/);
});

test("ingest: changing the parameter set later leaves earlier records' grades meaning what they meant", async () => {
  const l = Ledger.open(tmp());
  const grade = (grades: object): Model => async () => JSON.stringify({ decisions: [{ decision: "D", turn: "1", grades }] });
  await ingest(l, [{ author: "human", text: "first" }], grade({ codeSpan: 2 }), meta());
  const risk = [{ id: "risk", name: "Risk", low: "harmless", high: "dangerous" }];
  fs.writeFileSync(path.join(l.dir, CONFIG_FILE), JSON.stringify({ parameters: risk }));
  await ingest(l, [{ author: "human", text: "second" }], grade({ risk: 5, codeSpan: 3 }), meta());
  const [first, second] = l.stateAt().map((r) => r.record);
  assert.deepEqual([first.grades, second.grades], [{ codeSpan: 2 }, { risk: 5 }]);
  assert.deepEqual(l.get<ParameterSet>(first.parameterSet!).parameters, DEFAULT_PARAMETERS);
  assert.deepEqual(l.get<ParameterSet>(second.parameterSet!).parameters, risk);
});

test("ingest: a decision the engine marks as replacing #1 supersedes that ledger record", async () => {
  const l = Ledger.open(tmp());
  await ingest(l, [{ author: "human", text: "Use MySQL" }], async () => '{"decisions":[{"decision":"Use MySQL","turn":"1"}]}', meta());
  let prompt = "";
  const replaces: Model = async (_s, u) => ((prompt = u), '{"decisions":[{"decision":"Use Postgres","turn":"1","supersedes":"#1"}]}');
  await ingest(l, [{ author: "human", text: "Switch to Postgres" }], replaces, meta());
  const [mysql, postgres] = l.stateAt();
  assert.match(prompt, /#1 \(human: Priya\) Use MySQL/);
  assert.equal(postgres.record.supersedes, mysql.hash);
  assert.deepEqual(l.activeAt().map((r) => r.record.decision), ["Use Postgres"]);
});

test("ingest: authors get the given name, else the local person or 'ai'; names are cleaned once", async () => {
  const l = Ledger.open(tmp());
  const everyTurn: Model = async (_s, u) => {
    const ids = [...u.matchAll(/<turn id="(\d+)"/g)].map((m) => m[1]);
    return JSON.stringify({ decisions: ids.map((id) => ({ decision: `D${id}`, turn: id })) });
  };
  const turns = [
    { author: "human" as const, text: "a" },
    { author: "ai" as const, text: "b" },
    { author: "human" as const, name: " Sam\r\n| Lee ", text: "c" },
  ];
  await ingest(l, turns, everyTurn, meta());
  assert.deepEqual(
    l.stateAt().map((r) => r.record.author),
    [{ kind: "human", name: "Priya" }, { kind: "ai", name: "ai" }, { kind: "human", name: "Sam Lee" }]
  );
});

test("ingest input from outside (the CLI): authors use the engine's { kind, name } shape and are checked", () => {
  assert.deepEqual(parseIngestTurns([{ author: { kind: "human", name: "Sam" }, text: "x" }, { author: { kind: "ai" }, text: "y" }]), [
    { author: "human", name: "Sam", text: "x" },
    { author: "ai", name: undefined, text: "y" },
  ]);
  const rejects = (value: unknown, message: RegExp) => assert.throws(() => parseIngestTurns(value), (e: Error) => e instanceof InvalidInputError && message.test(e.message));
  rejects({}, /^turns: expected an array/);
  rejects([{ author: "human", text: "x" }], /^turns\[0\]\.author\.kind: expected "human" or "ai"/);
  rejects([{ author: { kind: "human", name: 42 }, text: "x" }], /^turns\[0\]\.author\.name: expected a string/);
  rejects([{ author: { kind: "ai" } }], /^turns\[0\]\.text: expected a string/);
});

test("chunk: long turns are split, not truncated, at natural breaks", () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} decides something about module ${i}.`);
  const text = paragraphs.join("\n\n");
  const chunks = splitText(text, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 300));
  for (const p of paragraphs) assert.ok(chunks.some((c) => c.includes(p)), `lost: ${p}`);
  assert.deepEqual(splitText("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("chunk: code is stripped before splitting, so no half code block reaches the model", () => {
  const code = Array.from({ length: 60 }, (_, i) => `const secret${i} = ${i};`).join("\n");
  const turn = { author: "ai" as const, text: `Use a config file.\n\`\`\`ts\n${code}\n\`\`\`\nDecided: keep it flat.`, externalId: "a", timestamp: "t", session: "S" };
  const chunks = chunkTurns([turn], 50);
  assert.ok(chunks.every((c) => !c.text.includes("secret")));
  assert.ok(chunks.some((c) => c.text.includes("keep it flat")));
  assert.ok(chunks.every((c) => c.author === "ai" && c.session === "S"));
});

test("batches: a batch ends where a source turn ends, unless one turn alone overflows it", () => {
  const at = (endOffset: number) => ({ author: "ai" as const, text: "x", externalId: "", timestamp: "", session: "", endOffset });
  assert.equal(batchSize([at(1), at(2), at(2), at(2), at(3)], 3), 1);
  assert.equal(batchSize([at(1), at(2), at(3), at(4)], 3), 3);
  assert.equal(batchSize([at(1), at(1), at(1), at(1)], 3), 3);
  assert.equal(batchSize([at(1), at(2)], 3), 2);
});

test("batches: new AI text merged into a chunked backlog moves all chunks of that turn together", () => {
  const ai = (text: string, endOffset: number) => ({ author: "ai" as const, text, externalId: "", timestamp: "", session: "", endOffset });
  const human = { ...ai("Go", 10), author: "human" as const };
  const backlog = chunkTurns([human, ai("word ".repeat(30), 50)], 40); // the AI turn becomes several chunks ending at 50
  assert.ok(backlog.filter((t) => t.endOffset === 50).length > 2);
  appendTurns(backlog, [ai("More from the same run.", 90)]);
  assert.deepEqual([...new Set(backlog.map((t) => t.endOffset))], [10, 90]);
  assert.equal(batchSize(backlog, 3), 1); // only the human turn ends on a boundary within 3
});

test("batches: a failure part-way keeps committed batches and a retry neither loses nor repeats turns", async () => {
  const l = Ledger.open(tmp());
  const turn = (i: number) => ({ author: "human" as const, text: `Decide thing ${i}`, externalId: "", timestamp: "t", session: "S", endOffset: i * 10 });
  const backlog = [1, 2, 3, 4].map(turn);
  const oneDecisionPerTurn: Model = async (_s, user) => {
    const sent = [...user.matchAll(/<turn id="(\w+)" author="\w+" name="[^"]*">\n(.*)\n/g)];
    return JSON.stringify({ decisions: sent.map(([, id, text]) => ({ decision: `Decision for: ${text}`, turn: id })) });
  };
  let calls = 0;
  const failsSecondTime: Model = async (s, u) => {
    if (++calls === 2) throw new Error("quota exceeded");
    return oneDecisionPerTurn(s, u);
  };
  const saved: number[] = []; // -1 = no safe offset for that batch
  const backlogMeta = meta({ origin: "claude-code", session: "S" });
  await assert.rejects(ingestBacklog(l, backlog, failsSecondTime, backlogMeta, 2, (b) => saved.push(b.safeOffset ?? -1)), /quota/);
  assert.deepEqual(saved, [20]);
  assert.equal(backlog.length, 2);
  assert.equal(l.stateAt().length, 2);

  await ingestBacklog(l, backlog, oneDecisionPerTurn, backlogMeta, 2, (b) => saved.push(b.safeOffset ?? -1));
  assert.deepEqual(saved, [20, 40]);
  assert.equal(backlog.length, 0);
  assert.equal(l.stateAt().length, 4);
  assert.equal(new Set(l.stateAt().map((r) => r.record.decision)).size, 4);
});

test("backoff: delays double up to a cap, each distinct error is reported once, reset clears it", () => {
  const b = new RetryBackoff();
  assert.ok(b.canTry(0));
  assert.equal(b.fail("no model", 0), true);
  assert.ok(!b.canTry(FIRST_RETRY_DELAY_MS - 1) && b.canTry(FIRST_RETRY_DELAY_MS));
  assert.equal(b.fail("no model", 0), false);
  assert.ok(!b.canTry(2 * FIRST_RETRY_DELAY_MS - 1));
  for (let i = 0; i < 20; i++) b.fail("no model", 0);
  assert.ok(b.canTry(MAX_RETRY_DELAY_MS));
  assert.equal(b.fail("quota exceeded", 0), true);
  b.reset();
  assert.ok(b.canTry(0));
  assert.equal(b.fail("quota exceeded", 0), true);
});

