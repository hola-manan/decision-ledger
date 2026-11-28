import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Ledger, ingest, ConfigError, NoModelError, ApiError, type IngestMeta } from "../src/core";
import type { Model } from "../engine/src";
import { DecisionLinker } from "../src/panel/linker";
import { sectionState } from "../src/panel/extraction";
import type { Exchange } from "../src/panel/exchanges";
import type { Phase } from "../src/panel/phase";
import type { ExtractionStatus } from "../src/watcher/status";

const tmp = () => Ledger.open(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-panel-")));
const SESSION = "S1";
const claudeCode = (more: Partial<IngestMeta> = {}): IngestMeta => ({ origin: "claude-code", session: SESSION, humanName: "Priya", ...more });

/** A model that turns each listed turn number into one decision, graded on codeSpan. */
function decides(...decisions: { turn: string; decision: string; supersedes?: string }[]): Model {
  return async () => JSON.stringify({ decisions: decisions.map((d) => ({ ...d, grades: { codeSpan: 3 } })) });
}

/** Log line uuid → exchange id, as the ExchangeBuilder would answer. */
const exchanges: Record<string, string> = { p1: "p1", a1: "p1", a1b: "p1", p2: "p2", a2: "p2" };
const exchangeOf = (uuid: string) => exchanges[uuid];

test("linker: human- and AI-grounded records land under the exchange their turn came from, in order", async () => {
  const ledger = tmp();
  await ingest(
    ledger,
    [
      { author: "human", text: "Use Postgres for users.", externalId: "p1" },
      { author: "ai", name: "claude-test", text: "I'll add a users table with UUID keys.", externalId: "a1" },
    ],
    decides({ turn: "1", decision: "Store users in Postgres." }, { turn: "2", decision: "Use UUID keys." }),
    claudeCode()
  );
  await ingest(ledger, [{ author: "human", text: "Cache sessions in Redis.", externalId: "p2" }], decides({ turn: "1", decision: "Cache sessions in Redis." }), claudeCode());
  const linked = new DecisionLinker(() => ledger).link(SESSION, exchangeOf);
  assert.deepEqual([...linked.keys()], ["p1", "p2"]);
  assert.deepEqual(linked.get("p1")!.map((d) => [d.record.seq, d.record.decision, d.record.author.kind]), [
    [1, "Store users in Postgres.", "human"],
    [2, "Use UUID keys.", "ai"],
  ]);
  const [first] = linked.get("p1")!;
  assert.equal(first.nodeHash, ledger.log().at(-1)!.hash, "the node that added it");
  assert.equal(linked.get("p2")![0].nodeHash, ledger.head());
  assert.deepEqual(first.grades.map((g) => [g.name, g.grade]), [["Code span", 3]]);
  assert.equal(first.replaces, null);
});

test("linker: records from another session, another origin, or with no externalId are left out", async () => {
  const ledger = tmp();
  await ingest(ledger, [{ author: "human", text: "Kept", externalId: "p2" }], decides({ turn: "1", decision: "This session." }), claudeCode());
  await ingest(ledger, [{ author: "human", text: "A", externalId: "p1" }], decides({ turn: "1", decision: "Other session." }), claudeCode({ session: "S2" }));
  await ingest(ledger, [{ author: "human", text: "B", externalId: "p1" }], decides({ turn: "1", decision: "From the CLI." }), claudeCode({ origin: "cli" }));
  await ingest(ledger, [{ author: "human", text: "C" }], decides({ turn: "1", decision: "No external id." }), claudeCode());
  await ingest(ledger, [{ author: "human", text: "D", externalId: "unknown-line" }], decides({ turn: "1", decision: "Line not in any exchange." }), claudeCode());
  const linked = new DecisionLinker(() => ledger).link(SESSION, exchangeOf);
  assert.deepEqual([...linked.entries()].map(([id, list]) => [id, list.map((d) => d.record.decision)]), [["p2", ["This session."]]]);
});

test("linker: an empty ledger links nothing; linking twice gives the same answer", async () => {
  const ledger = tmp();
  const linker = new DecisionLinker(() => ledger);
  assert.equal(linker.link(SESSION, exchangeOf).size, 0);
  await ingest(ledger, [{ author: "human", text: "Use Postgres.", externalId: "p1" }], decides({ turn: "1", decision: "Use Postgres." }), claudeCode());
  const first = linker.link(SESSION, exchangeOf);
  assert.deepEqual(linker.link(SESSION, exchangeOf), first);
});

test("linker: switching back to a branch whose nodes are all indexed, and a detached HEAD, link the right records", async () => {
  const ledger = tmp();
  await ingest(ledger, [{ author: "human", text: "Use MySQL.", externalId: "p1" }], decides({ turn: "1", decision: "Use MySQL." }), claudeCode());
  const first = ledger.head()!;
  await ingest(ledger, [{ author: "human", text: "Cache in Redis.", externalId: "p2" }], decides({ turn: "1", decision: "Cache in Redis." }), claudeCode());
  const mainHead = ledger.head()!;
  const linker = new DecisionLinker(() => ledger);
  linker.link(SESSION, exchangeOf);
  ledger.checkout(first);
  assert.deepEqual([...linker.link(SESSION, exchangeOf).keys()], ["p1"], "detached at the first node");
  ledger.checkout("main");
  const back = linker.link(SESSION, exchangeOf);
  assert.equal(back.get("p2")![0].nodeHash, mainHead);
});

test("linker: a node that can't be read is retried on the next call, not lost", async () => {
  const ledger = tmp();
  await ingest(ledger, [{ author: "human", text: "Use MySQL.", externalId: "p1" }], decides({ turn: "1", decision: "Use MySQL." }), claudeCode());
  const older = ledger.head()!;
  await ingest(ledger, [{ author: "human", text: "Cache in Redis.", externalId: "p2" }], decides({ turn: "1", decision: "Cache in Redis." }), claudeCode());
  const realGet = ledger.get.bind(ledger);
  let failOnce = true;
  (ledger as { get: typeof ledger.get }).get = ((hash: string) => {
    if (hash === older && failOnce) {
      failOnce = false;
      throw new Error("EBUSY: file is being synced");
    }
    return realGet(hash);
  }) as typeof ledger.get;
  const linker = new DecisionLinker(() => ledger);
  assert.throws(() => linker.link(SESSION, exchangeOf), /EBUSY/);
  assert.deepEqual([...linker.link(SESSION, exchangeOf).keys()], ["p1", "p2"]);
});

test("linker: replaces names the superseded record; a record on another branch disappears after checkout", async () => {
  const ledger = tmp();
  await ingest(ledger, [{ author: "human", text: "Use MySQL.", externalId: "p1" }], decides({ turn: "1", decision: "Use MySQL." }), claudeCode());
  const base = ledger.head()!;
  ledger.createBranch("experiment", base);
  await ingest(ledger, [{ author: "human", text: "No, Postgres.", externalId: "p2" }], decides({ turn: "1", decision: "Use Postgres.", supersedes: "#1" }), claudeCode());
  const linker = new DecisionLinker(() => ledger);
  const replacing = linker.link(SESSION, exchangeOf).get("p2")![0];
  assert.deepEqual(
    { seq: replacing.replaces?.seq, decision: replacing.replaces?.decision, authorName: replacing.replaces?.authorName },
    { seq: 1, decision: "Use MySQL.", authorName: "Priya" }
  );
  ledger.checkout("experiment");
  const onExperiment = linker.link(SESSION, exchangeOf);
  assert.deepEqual([...onExperiment.keys()], ["p1"], "the Postgres record is on main only");
  await ingest(ledger, [{ author: "ai", text: "Trying SQLite here.", externalId: "a2" }], decides({ turn: "1", decision: "Use SQLite on this branch." }), claudeCode());
  const afterCommit = linker.link(SESSION, exchangeOf);
  assert.equal(afterCommit.get("p2")![0].record.decision, "Use SQLite on this branch.");
  assert.equal(afterCommit.get("p2")![0].nodeHash, ledger.head(), "nodes added after a branch switch are indexed");
});

const exchange = (endOffset: number) => ({ endOffset }) as Exchange;
const ENDED: Phase = { phase: "ended", endReason: "done" };
const WORKING: Phase = { phase: "working", endReason: null };
const status = (more: Partial<ExtractionStatus> = {}): ExtractionStatus => ({ enabled: true, committedOffset: 0, inFlight: null, failure: null, ...more });

test("section state: every row of its table, in order", () => {
  const failed = (error: unknown) => status({ committedOffset: 100, failure: { error, retryAt: null } });
  const cases: [string, Exchange, Phase, ExtractionStatus, string][] = [
    ["watching off wins over everything", exchange(50), ENDED, status({ enabled: false, committedOffset: 100 }), "off"],
    ["reply still running", exchange(50), WORKING, status({ committedOffset: 100 }), "notYet"],
    ["reply still running beats a failure", exchange(150), WORKING, failed(new NoModelError("no model")), "notYet"],
    ["committed, maybe with no decisions", exchange(100), ENDED, status({ committedOffset: 100 }), "done"],
    ["committed beats a later failure", exchange(100), ENDED, failed(new ApiError("anthropic", 500, "boom")), "done"],
    ["not committed, no model", exchange(150), ENDED, failed(new NoModelError("no model")), "noModel"],
    ["not committed, broken config", exchange(150), ENDED, failed(new ConfigError("bad json")), "configInvalid"],
    ["not committed, any other failure", exchange(150), ENDED, failed(new Error("disk full")), "failed"],
    ["ended and waiting to be committed", exchange(150), ENDED, status({ committedOffset: 100, inFlight: { fromOffset: 100, toOffset: 150 } }), "extracting"],
  ];
  for (const [name, ex, phase, st, expected] of cases) assert.equal(sectionState({ exchange: ex, phase, status: st }), expected, name);
});
