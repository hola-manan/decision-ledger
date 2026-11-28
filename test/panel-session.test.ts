import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createSessionLogSource, type SessionFile } from "../src/claude-log";
import { SessionFollower, type FollowChoice } from "../src/panel/follower";

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-follow-"));
  made.push(dir);
  return dir;
};
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
/** The panel opened before any prompt in these tests was typed. */
const FOLLOWING_SINCE = Date.parse("2026-11-28T08:00:00Z");
const line = (o: object) => JSON.stringify(o) + "\n";
const prompt = (uuid: string, timestamp = "2026-11-28T10:00:00Z") => line({ type: "user", uuid, timestamp, message: { content: `Prompt ${uuid}` } });
const reply = (uuid: string) => line({ type: "assistant", uuid, message: { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } });

/** A workspace whose Claude Code project folder holds the given sessions, oldest first. */
function setUp(...sessions: string[]) {
  const workspace = path.join(tmp(), "proj");
  const projects = tmp();
  const dir = path.join(projects, path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir);
  const fileOf = (id: string) => path.join(dir, `${id}.jsonl`);
  sessions.forEach((id, i) => {
    fs.writeFileSync(fileOf(id), prompt(`${id}-1`));
    const time = new Date(Date.parse("2026-11-28T09:00:00Z") + i * 60_000);
    fs.utimesSync(fileOf(id), time, time);
  });
  const source = createSessionLogSource({ projectsDir: projects, workspace, pollMs: 1000, polling: "manual" });
  const closely: (string | undefined)[] = [];
  const watchClosely = source.watchClosely.bind(source);
  source.watchClosely = (file) => (closely.push(file), watchClosely(file));
  source.acquire();
  const saved: FollowChoice[] = [];
  const follow = (initial: FollowChoice = { mode: "auto" }) => {
    const follower = new SessionFollower(source, initial, (choice) => saved.push(choice), () => FOLLOWING_SINCE);
    const changes: (string | undefined)[] = [];
    follower.onDidChange((file: SessionFile | undefined) => changes.push(file?.sessionId));
    return { follower, changes };
  };
  return { source, dir, fileOf, follow, saved, closely };
}

test("follower: with no sessions, nothing is followed; a session that appears is followed", () => {
  const { source, fileOf, follow } = setUp();
  const { follower, changes } = follow();
  assert.equal(follower.current(), undefined);
  fs.writeFileSync(fileOf("first"), prompt("f1"));
  source.tick();
  assert.equal(follower.current()?.sessionId, "first");
  assert.deepEqual(changes, ["first"]);
});

test("follower: first open follows the newest session, and watches it closely", () => {
  const { follow, fileOf, closely } = setUp("older", "newest");
  const { follower } = follow();
  assert.equal(follower.current()?.sessionId, "newest");
  assert.equal(follower.mode, "auto");
  assert.equal(closely.at(-1), fileOf("newest"));
});

test("follower: in auto mode a prompt in another session switches to it; replies alone don't", () => {
  const { source, fileOf, follow, closely } = setUp("a", "b");
  const { follower, changes } = follow();
  fs.appendFileSync(fileOf("a"), reply("a-reply"));
  source.tick();
  assert.equal(follower.current()?.sessionId, "b", "assistant-only growth stays put");
  fs.appendFileSync(fileOf("a"), prompt("a-2"));
  source.tick();
  assert.equal(follower.current()?.sessionId, "a");
  assert.deepEqual(changes, ["a"]);
  assert.equal(closely.at(-1), fileOf("a"));
});

test("follower: pinned, prompts elsewhere don't move it; follow latest goes to the newest prompt", () => {
  const { source, fileOf, follow, saved } = setUp("a", "b", "c");
  const { follower, changes } = follow();
  assert.equal(follower.pin("a"), true);
  assert.equal(follower.pin("missing"), false);
  fs.appendFileSync(fileOf("b"), prompt("b-2"));
  source.tick();
  assert.equal(follower.current()?.sessionId, "a");
  fs.appendFileSync(fileOf("c"), reply("c-reply"));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(fileOf("c"), later, later);
  source.tick();
  follower.followLatest();
  assert.equal(follower.current()?.sessionId, "b", "b had the newest prompt, though c changed last");
  assert.deepEqual(changes, ["a", "b"]);
  assert.deepEqual(saved, [{ mode: "pinned", sessionId: "a" }, { mode: "auto" }]);
});

test("follower: the saved choice is restored; a pinned session that's gone falls back to auto and is saved", () => {
  const { follow, saved } = setUp("a", "b");
  const { follower } = follow({ mode: "pinned", sessionId: "a" });
  assert.equal(follower.current()?.sessionId, "a");
  assert.equal(follower.mode, "pinned");
  const missing = follow({ mode: "pinned", sessionId: "deleted-while-closed" });
  assert.equal(missing.follower.mode, "auto");
  assert.equal(missing.follower.current()?.sessionId, "b");
  assert.deepEqual(saved, [{ mode: "auto" }]);
});

test("follower: when the pinned file is deleted, it falls back to auto with a change event", () => {
  const { source, fileOf, follow, saved } = setUp("a", "b");
  const { follower, changes } = follow({ mode: "pinned", sessionId: "a" });
  fs.rmSync(fileOf("a"));
  source.tick();
  assert.equal(follower.mode, "auto");
  assert.equal(follower.current()?.sessionId, "b");
  assert.deepEqual(changes, ["b"]);
  assert.deepEqual(saved, [{ mode: "auto" }]);
  fs.rmSync(fileOf("b"));
  source.tick();
  assert.equal(follower.current(), undefined);
  assert.deepEqual(changes, ["b", undefined]);
});

test("follower: dispose stops following and closely watching", () => {
  const { source, fileOf, follow, closely } = setUp("a", "b");
  const { follower, changes } = follow();
  follower.dispose();
  fs.appendFileSync(fileOf("a"), prompt("a-2"));
  source.tick();
  assert.deepEqual(changes, []);
  assert.equal(closely.at(-1), undefined);
});

test("follower: pinning the session already followed, or following latest from it, still announces the mode change", () => {
  const { follow, saved } = setUp("a", "b");
  const { follower, changes } = follow();
  assert.equal(follower.pin("b"), true);
  assert.equal(follower.mode, "pinned");
  assert.deepEqual(changes, ["b"], "same session, new mode");
  follower.followLatest();
  assert.equal(follower.mode, "auto");
  assert.deepEqual(changes, ["b", "b"]);
  assert.deepEqual(saved, [{ mode: "pinned", sessionId: "b" }, { mode: "auto" }]);
});

test("follower: old prompts replayed from a session found later don't move the panel; a new one does", () => {
  const { source, fileOf, follow } = setUp("a");
  const { follower, changes } = follow();
  fs.writeFileSync(fileOf("old"), prompt("old-1", "2026-11-27T10:00:00Z") + prompt("old-2", "2026-11-27T11:00:00Z"));
  source.tick();
  assert.equal(follower.current()?.sessionId, "a", "history from yesterday, read from the file's start");
  fs.appendFileSync(fileOf("old"), prompt("old-3", "2026-11-28T10:30:00Z"));
  source.tick();
  assert.equal(follower.current()?.sessionId, "old");
  assert.deepEqual(changes, ["old"]);
});
