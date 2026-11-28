import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFileChanges } from "../src/panel/files";
import { activityText, THINKING, WRITING_REPLY } from "../src/panel/activity";
import { exchangeOf, fixtureExchange } from "./panel-helpers";

const ROOT = "/work/proj/";
const prompt = { type: "user", uuid: "p", message: { content: "Do it" } };
let n = 0;
const use = (id: string, name: string, input: object = {}) => ({
  type: "assistant",
  uuid: `a${++n}`,
  message: { id: `m${n}`, model: "m", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, extra: object = {}, isError = false, content = "ok") => ({
  type: "user",
  uuid: `r${++n}`,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  ...extra,
});
const text = (words: string) => ({ type: "assistant", uuid: `t${++n}`, message: { id: `m${n}`, model: "m", content: [{ type: "text", text: words }] } });
const edit = (file: string, oldString: string, newString: string) => ({ file_path: file, old_string: oldString, new_string: newString });
const relative = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length) : p);

test("files: counts per tool from Claude Code's results; a notebook's counts are unknown; Bash adds nothing", () => {
  assert.deepEqual(collectFileChanges(fixtureExchange("edit-write-multiedit-notebook")), [
    { path: "/work/proj/src/db.ts", kind: "modified", added: 3, removed: 2 },
    { path: "/work/proj/src/migrate.ts", kind: "added", added: 4, removed: 0 },
    { path: "/work/proj/src/user.ts", kind: "modified", added: 3, removed: 3 },
    { path: "/work/proj/analysis.ipynb", kind: "modified" },
  ]);
  assert.deepEqual(collectFileChanges(fixtureExchange("bash")), []);
});

test("files: repeated edits to one path are summed, in first-touch order; the first change sets the kind", () => {
  const exchange = exchangeOf([
    prompt,
    use("w", "Write", { file_path: "/p/new.ts", content: "a\nb\n" }),
    result("w", { toolUseResult: { type: "create", filePath: "/p/new.ts", content: "a\nb\n", structuredPatch: [] } }),
    use("e1", "Edit", edit("/p/old.ts", "x", "y\nz")),
    result("e1"),
    use("e2", "Edit", edit("/p/new.ts", "a", "a\nc")),
    result("e2"),
    use("e3", "Edit", edit("/p/old.ts", "q\nr", "s")),
    result("e3"),
  ]);
  assert.deepEqual(collectFileChanges(exchange), [
    { path: "/p/new.ts", kind: "added", added: 4, removed: 1 },
    { path: "/p/old.ts", kind: "modified", added: 3, removed: 3 },
  ]);
});

test("files: failed, denied and still-pending calls don't count", () => {
  const exchange = exchangeOf([
    prompt,
    use("fail", "Edit", edit("/p/a.ts", "x", "y")),
    result("fail", {}, true, "String not found"),
    use("deny", "Edit", edit("/p/b.ts", "x", "y")),
    result("deny", {}, true, "The user doesn't want to proceed with this tool use. The tool use was rejected."),
    use("wait", "Edit", edit("/p/c.ts", "x", "y")),
  ]);
  assert.deepEqual(collectFileChanges(exchange), []);
});

test("files: once a change to a path has unknown counts, the sum stays unknown", () => {
  const exchange = exchangeOf([
    prompt,
    use("w", "Write", { file_path: "/p/a.ts", content: "a\nb\n" }),
    result("w"),
    use("e", "Edit", edit("/p/a.ts", "a", "c")),
    result("e"),
  ]);
  assert.deepEqual(collectFileChanges(exchange), [{ path: "/p/a.ts", kind: "modified", added: 3 }], "a Write without a result patch: removed unknown");
});

test("files: two spellings of one Windows path are one row, shown as first spelled", { skip: process.platform !== "win32" && "Windows paths" }, () => {
  const exchange = exchangeOf([
    prompt,
    use("e1", "Edit", edit("C:\\proj\\src\\a.ts", "x", "y")),
    result("e1"),
    use("e2", "Edit", edit("c:/proj/src/a.ts", "x", "y")),
    result("e2"),
  ]);
  assert.deepEqual(collectFileChanges(exchange), [{ path: "C:\\proj\\src\\a.ts", kind: "modified", added: 2, removed: 2 }]);
});

test("activity: wording for each tool, with paths as the caller shows them", () => {
  const cases: [string, object, string][] = [
    ["Read", { file_path: "/work/proj/src/users/userRepository.ts" }, "Reading src/users/userRepository.ts…"],
    ["Edit", edit("/work/proj/src/db/client.ts", "a", "b"), "Editing src/db/client.ts…"],
    ["MultiEdit", { file_path: "/work/proj/src/a.ts", edits: [] }, "Editing src/a.ts…"],
    ["NotebookEdit", { notebook_path: "/work/proj/n.ipynb" }, "Editing n.ipynb…"],
    ["Write", { file_path: "/work/proj/prisma/schema.prisma", content: "x" }, "Writing prisma/schema.prisma…"],
    ["Bash", { command: "npm test -- --watch=false", description: "Run the tests" }, "Run the tests…"],
    ["Bash", { command: "npm test", description: "Run the tests." }, "Run the tests…"],
    ["Bash", { command: "npm test" }, "Running npm test…"],
    ["Bash", { command: "cd .." }, "Running cd ..…"],
    ["Bash", { command: "x".repeat(300) }, `Running ${"x".repeat(199)}…`],
    ["Grep", { pattern: "sendEmail" }, 'Searching for "sendEmail"…'],
    ["Glob", { pattern: "*.test.ts" }, "Finding files matching *.test.ts…"],
    ["WebFetch", { url: "https://docs.example.dev/guide?x=1" }, "Fetching docs.example.dev…"],
    ["WebSearch", { query: "prisma migrate" }, "Searching the web…"],
    ["Task", { description: "review the migration", prompt: "…" }, "Running a sub-agent: review the migration…"],
    ["Agent", { description: "review the migration" }, "Running a sub-agent: review the migration…"],
    ["AskUserQuestion", { questions: [] }, "Asking you a question…"],
    ["TodoWrite", { todos: [] }, "Updating the to-do list…"],
    ["mcp__db__query", {}, "Using mcp__db__query…"],
    ["Read", {}, "Reading a file…"],
  ];
  for (const [tool, input, expected] of cases) {
    assert.equal(activityText(exchangeOf([prompt, use(`c-${tool}`, tool, input)]), relative), expected, `${tool} ${JSON.stringify(input).slice(0, 40)}`);
  }
});

test("activity: the oldest running call wins (later ones are queued); with none, writing the reply or thinking", () => {
  assert.equal(activityText(exchangeOf([prompt, use("t", "Task", { description: "check it" }), use("b", "Bash", { command: "ls" })])), "Running a sub-agent: check it…");
  assert.equal(activityText(exchangeOf([prompt, use("r", "Read", { file_path: "/a" }), use("b", "Bash", { command: "ls" }), result("r")])), "Running ls…");
  assert.equal(activityText(exchangeOf([prompt])), THINKING);
  assert.equal(activityText(exchangeOf([prompt, use("b", "Bash", { command: "ls" }), result("b")])), THINKING);
  assert.equal(activityText(exchangeOf([prompt, text("Here is the plan")])), WRITING_REPLY);
  assert.equal(activityText(exchangeOf([prompt, text("Here is the plan"), text("\n\n")])), THINKING, "a blank text part isn't writing");
});
