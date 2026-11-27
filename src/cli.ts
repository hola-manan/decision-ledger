#!/usr/bin/env node
/**
 * Output 2 — the backend. Any agent or script can write to and read from the same ledger.
 *
 *   ledger log                      nodes from HEAD back
 *   ledger state [node]             active decisions at a node (default HEAD)
 *   ledger show <record|node>       one object as JSON
 *   ledger diff <a> <b>             decisions added/removed between nodes
 *   ledger branch [name [at]]       list or create branches
 *   ledger checkout <branch|node>
 *   ledger ingest --origin X --session Y   < turns.json   ([{author:{kind:"human"|"ai", name?}, text}])
 *
 * Run from the project root (where .ledger/ lives). `ingest` needs ANTHROPIC_API_KEY or GEMINI_API_KEY.
 */
import { Ledger, DecisionRecord } from "./core/store";
import { ingest, parseIngestTurns } from "./core/ingest";
import { modelFromEnv } from "../engine/src";
import { localHumanName } from "./core/identity";

const [cmd, ...args] = process.argv.slice(2);
const l = Ledger.open(process.cwd());
/** One line per record: #seq, author, decision, grades, what it replaces, hash. */
const fmt = (h: string, r: DecisionRecord) =>
  [
    `#${r.seq}`,
    r.author.name === r.author.kind ? r.author.kind : `${r.author.kind}:${r.author.name}`, // v0.1 records have no name
    r.decision,
    Object.entries(r.grades).map(([id, grade]) => `${id}=${grade}`).join(" "),
    r.supersedes ? `(supersedes ${r.supersedes.slice(0, 7)})` : "",
    `[${h.slice(0, 7)}]`,
  ]
    .filter(Boolean)
    .join("\t");
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  switch (cmd) {
    case "log":
      for (const { hash, node } of l.log()) console.log(`${hash.slice(0, 7)}  ${node.timestamp}  +${node.added.length}  [${node.origin}] ${node.message}`);
      break;
    case "state":
      for (const { hash, record } of l.activeAt(args[0])) console.log(fmt(hash, record));
      break;
    case "show":
      console.log(JSON.stringify(l.get(args[0]), null, 2));
      break;
    case "diff": {
      const d = l.diff(args[0], args[1]);
      for (const h of d.added) console.log("+ " + fmt(h, l.record(h)));
      for (const h of d.removed) console.log("- " + fmt(h, l.record(h)));
      break;
    }
    case "branch":
      if (args[0]) l.createBranch(args[0], args[1]);
      else for (const b of l.branches()) console.log(`${b.current ? "*" : " "} ${b.name}  ${b.head?.slice(0, 7) ?? ""}`);
      break;
    case "checkout":
      l.checkout(args[0]);
      break;
    case "ingest": {
      const model = modelFromEnv();
      let input = "";
      for await (const c of process.stdin) input += c;
      const turns = parseIngestTurns(JSON.parse(input));
      const r = await ingest(l, turns, model, {
        origin: flag("origin") ?? "cli",
        session: flag("session") ?? new Date().toISOString(),
        humanName: localHumanName(process.cwd()),
      });
      if (!r) console.log("No decisions.");
      else for (const h of r.records) console.log(fmt(h, l.record(h)));
      break;
    }
    default:
      console.log("usage: ledger <log|state|show|diff|branch|checkout|ingest> …");
  }
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
