import type { DecisionRecord, Ledger, LedgerNode, Turn } from "./core/store";
import { shortHash } from "./core/ingest";

export const who = (a: string) => (a === "human" ? "👤 human" : "🤖 ai");

export function cmdLink(cmd: string, label: string, ...args: unknown[]): string {
  return `[${label}](command:${cmd}?${encodeURIComponent(JSON.stringify(args))})`;
}

export function recordLine(hash: string, r: DecisionRecord, withLink = true): string {
  let s = `**#${r.seq}** ${r.decision} · ${who(r.author)}`;
  if (withLink) s += ` · ${cmdLink("ledger.openRecord", "source", hash)}`;
  if (r.rationale) s += `\n  - _why:_ ${r.rationale}`;
  if (r.quote) s += `\n  - > “${r.quote}”`;
  return s;
}

export function recordDoc(ledger: Ledger, hash: string): string {
  const r = ledger.get<DecisionRecord>(hash);
  const t = ledger.get<Turn>(r.turn);
  const lines = [
    `# Decision #${r.seq}`,
    ``,
    `**${r.decision}**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Brought by | ${who(r.author)} |`,
    `| When | ${r.timestamp} |`,
    `| Record | \`${hash}\` |`,
    `| Grounded in turn | \`${shortHash(r.turn)}\` (${t.origin}, session \`${t.session.slice(0, 12)}\`) |`,
  ];
  if (r.supersedes) {
    const old = ledger.get<DecisionRecord>(r.supersedes);
    lines.push(`| Supersedes | #${old.seq} ${old.decision} |`);
  }
  if (r.rationale) lines.push(``, `**Why:** ${r.rationale}`);
  if (r.quote) lines.push(``, `**Grounding quote:**`, ``, `> ${r.quote}`);
  lines.push(``, `---`, ``, `## Source turn (${who(t.author)})`, ``, t.text.split("\n").map((l) => "> " + l).join("\n"));
  return lines.join("\n");
}

export function stateDoc(ledger: Ledger, nodeHash: string): string {
  const node = ledger.get<LedgerNode>(nodeHash);
  const all = ledger.stateAt(nodeHash);
  const active = new Set(ledger.activeAt(nodeHash).map((a) => a.hash));
  const lines = [
    `# Decisions at node \`${shortHash(nodeHash)}\``,
    ``,
    `_${node.message}_ · ${node.timestamp} · ${active.size} active, ${all.length - active.size} superseded`,
    ``,
    `## Active`,
    ``,
    ...all.filter((a) => active.has(a.hash)).map((a) => "- " + recordLine(a.hash, a.record)),
  ];
  const dead = all.filter((a) => !active.has(a.hash));
  if (dead.length) lines.push(``, `## Superseded`, ``, ...dead.map((a) => "- ~~" + `#${a.record.seq} ${a.record.decision}` + "~~"));
  return lines.join("\n");
}

export function diffDoc(ledger: Ledger, a: string | null, b: string): string {
  const d = a ? ledger.diff(a, b) : { added: ledger.get<LedgerNode>(b).state, removed: [] as string[] };
  const lines = [`# Diff \`${a ? shortHash(a) : "∅"}\` → \`${shortHash(b)}\``, ``];
  for (const h of d.added) lines.push("- ➕ " + recordLine(h, ledger.get<DecisionRecord>(h)));
  for (const h of d.removed) lines.push("- ➖ " + recordLine(h, ledger.get<DecisionRecord>(h)));
  if (!d.added.length && !d.removed.length) lines.push("_No differences._");
  return lines.join("\n");
}
