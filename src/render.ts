import { GRADE_MAX, GRADE_MIN } from "../engine/src";
import type { Author, DecisionRecord, Ledger, LedgerNode, ParameterSet } from "./core/store";
import { shortHash } from "./core/ingest";

export const who = (a: Author) => `${a.kind === "human" ? "👤" : "🤖"} ${a.name}`;

export function cmdLink(cmd: string, label: string, ...args: unknown[]): string {
  return `[${label}](command:${cmd}?${encodeURIComponent(JSON.stringify(args))})`;
}

/** Each grade with its parameter's name, as it was defined when the record was graded. */
export function namedGrades(ledger: Ledger, r: DecisionRecord): { name: string; grade: number; low?: string; high?: string }[] {
  const definitions = r.parameterSet ? ledger.get<ParameterSet>(r.parameterSet).parameters : [];
  return Object.entries(r.grades).map(([id, grade]) => {
    const definition = definitions.find((p) => p.id === id);
    return { name: definition?.name ?? id, grade, low: definition?.low, high: definition?.high };
  });
}

/** "Code span 4/5 · Reversibility 2/5", or "" if ungraded. */
export function gradesText(ledger: Ledger, r: DecisionRecord): string {
  return namedGrades(ledger, r)
    .map((g) => `${g.name} ${g.grade}/${GRADE_MAX}`)
    .join(" · ");
}

export function recordLine(ledger: Ledger, hash: string, r: DecisionRecord, withLink = true): string {
  let s = `**#${r.seq}** ${r.decision} · ${who(r.author)}`;
  if (withLink) s += ` · ${cmdLink("ledger.openRecord", "source", hash)}`;
  const grades = gradesText(ledger, r);
  if (grades) s += `\n  - ${grades}`;
  if (r.rationale) s += `\n  - _why:_ ${r.rationale}`;
  if (r.source.quote) s += `\n  - > “${r.source.quote}”`;
  return s;
}

export function recordDoc(ledger: Ledger, hash: string): string {
  const r = ledger.record(hash);
  const t = ledger.turn(r.source.turn);
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
    `| Source | turn \`${shortHash(r.source.turn)}\` (${t.origin}, session \`${t.session.slice(0, 12)}\`) |`,
  ];
  if (r.supersedes) {
    const old = ledger.record(r.supersedes);
    lines.push(`| Supersedes | #${old.seq} ${old.decision} |`);
  }
  lines.push(...gradesTable(ledger, r));
  if (r.rationale) lines.push(``, `**Why:** ${r.rationale}`);
  if (r.source.quote) lines.push(``, `**Grounding quote:**`, ``, `> ${r.source.quote}`);
  lines.push(``, `---`, ``, `## Source message (${who(t.author)})`, ``, t.text.split("\n").map((l) => "> " + l).join("\n"));
  return lines.join("\n");
}

function gradesTable(ledger: Ledger, r: DecisionRecord): string[] {
  const grades = namedGrades(ledger, r);
  if (!grades.length) return [];
  const rows = grades.map((g) => `| ${g.name} | ${g.grade}/${GRADE_MAX} | ${g.low && g.high ? `${GRADE_MIN} = ${g.low}; ${GRADE_MAX} = ${g.high}` : ""} |`);
  return [``, `| Parameter | Grade | Scale |`, `|---|---|---|`, ...rows];
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
    ...all.filter((a) => active.has(a.hash)).map((a) => "- " + recordLine(ledger, a.hash, a.record)),
  ];
  const dead = all.filter((a) => !active.has(a.hash));
  if (dead.length) lines.push(``, `## Superseded`, ``, ...dead.map((a) => `- #${a.record.seq} ${a.record.decision}`));
  return lines.join("\n");
}

export function diffDoc(ledger: Ledger, a: string | null, b: string): string {
  const d = a ? ledger.diff(a, b) : { added: ledger.get<LedgerNode>(b).state, removed: [] as string[] };
  const lines = [`# Diff \`${a ? shortHash(a) : "∅"}\` → \`${shortHash(b)}\``, ``];
  for (const h of d.added) lines.push("- ➕ " + recordLine(ledger, h, ledger.record(h)));
  for (const h of d.removed) lines.push("- ➖ " + recordLine(ledger, h, ledger.record(h)));
  if (!d.added.length && !d.removed.length) lines.push("_No differences._");
  return lines.join("\n");
}
