/**
 * Separates code from prose. Code is never sent for processing, so everything here
 * errs toward finding code: fenced blocks always, and unfenced runs of lines that
 * look like code (e.g. a paste with no ``` around it).
 */
import { CODE_PLACEHOLDER } from "../../engine/src";

/** The engine's contract defines what removed code is replaced with. */
export { CODE_PLACEHOLDER };

export interface Segment {
  kind: "prose" | "code";
  text: string;
}

const FENCE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)/g;

/**
 * Unfenced code is only cut when at least this many lines look like code, so a
 * stray prose line ending in ";" or "{" is never mistaken for a paste.
 */
const MIN_UNFENCED_CODE_LINES = 3;

/** Markdown list items. Prose lists often end items with ";", which must not read as code. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Unified-diff headers. Only after one of these are "+"/"-" lines read as diff changes. */
const DIFF_HEADER = /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- a\/|\+\+\+ b\/)/;

/** A changed line inside a diff. Outside a diff the same shape is a markdown list item. */
const DIFF_CHANGE = /^[+-]/;

/** Python-style block header. Only code when an indented body follows, since prose also ends lines with ":". */
const BLOCK_HEADER = /^\s*(?:if|elif|else|for|while|try|except|with)\b[^.]*:\s*$/;

/**
 * Strong, single-line signs of code. Keywords are matched case-sensitively and must be
 * followed by code punctuation, so lowercase chat prose ("let's use x") doesn't match.
 */
const CODE_LINE_PATTERNS: RegExp[] = [
  /[;{]\s*$/, // ends a statement or opens a block
  /^\s*[}\])]/, // closes a block
  /^\s*(?:import|export|const|let(?!')|var|function|class|def|return|async|await|public|private|protected|package|using|interface|enum|struct|fn|func)\b.*[=({:;]/,
  /^\s*"[^"]+"\s*:/, // JSON key
  /^\s*(?:\/\/|\/\*|\*\/|#!|#include\b)/, // comment, shebang, include
  /^\s*[\w.$[\]]+\s*(?:=|\+=|-=|:=)\s*\S/, // assignment
  /^\s*(?:await\s+)?[\w.$]+\([^)]*\)\s*;?\s*$/, // bare call
  /^\s*<\/?[a-zA-Z][\w.:-]*(?:\s[^>]*)?\/?>/, // starts with a markup tag (HTML, XML, JSX)
  /^\s*(?:SELECT|WHERE|INSERT INTO|DELETE FROM|(?:LEFT |RIGHT |INNER )?JOIN|ORDER BY|GROUP BY)\b/, // SQL, uppercase only
  /^\s*(?:FROM|SET|DROP|VALUES|UPDATE|CREATE|ALTER)\b.*[,=(;]/, // SQL words that also open all-caps prose
];

/** SQL clauses that may stand alone on a line ("FROM users"); they continue a run but don't start one. */
const SQL_CLAUSE = /^\s*(?:FROM|SET|DROP|VALUES|UPDATE|CREATE|ALTER)\b/;

/** Replace every code segment with a placeholder. */
export function stripCode(text: string): string {
  return segments(text)
    .map((s) => (s.kind === "code" ? CODE_PLACEHOLDER : s.text))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split text into prose and code segments, keeping code verbatim. */
export function splitCode(text: string): Segment[] {
  return segments(text).filter((s) => s.text.trim());
}

/** Whether a code segment was written inside a fence (vs. detected as unfenced). */
export function isFenced(code: string): boolean {
  return /^(```|~~~)/.test(code);
}

/** A code segment as markdown: fenced ones as-is, unfenced ones wrapped in a fence they can't close early. */
export function asMarkdownCode(code: string): string {
  if (isFenced(code)) return code;
  const longestBacktickRun = (code.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 2);
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}\n${code}\n${fence}`;
}

function segments(text: string): Segment[] {
  return splitFenced(text).flatMap((s) => (s.kind === "prose" ? splitUnfenced(s.text) : [s]));
}

function splitFenced(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const start = m.index! + m[1].length; // the newline before a fence stays in the prose
    out.push({ kind: "prose", text: text.slice(last, start) });
    out.push({ kind: "code", text: text.slice(start, m.index! + m[0].length) });
    last = m.index! + m[0].length;
  }
  out.push({ kind: "prose", text: text.slice(last) });
  return out;
}

function splitUnfenced(text: string): Segment[] {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let position = 0;
  for (const line of lines) {
    lineStarts.push(position);
    position += line.length + 1;
  }
  const out: Segment[] = [];
  let last = 0;
  for (const [first, end] of findCodeRuns(lines)) {
    const start = lineStarts[first];
    const stop = lineStarts[end] + lines[end].length;
    out.push({ kind: "prose", text: text.slice(last, start) });
    out.push({ kind: "code", text: text.slice(start, stop) });
    last = stop;
  }
  out.push({ kind: "prose", text: text.slice(last) });
  return out;
}

/**
 * Inclusive [first, last] line ranges of unfenced code. A run starts on a code-like
 * line; indented lines, bare SQL clauses and diff changes inside it (and right after
 * it) belong to it.
 */
function findCodeRuns(lines: string[]): [number, number][] {
  const runs: [number, number][] = [];
  const run = { first: -1, last: -1, codeLines: 0, inDiff: false };
  const closeRun = () => {
    if (run.codeLines >= MIN_UNFENCED_CODE_LINES) runs.push([run.first, run.last]);
    Object.assign(run, { first: -1, codeLines: 0, inDiff: false });
  };
  // Lines inside a closed /* ... */ are code even when they look like prose or list items (" * - foo").
  let inBlockComment = false;
  lines.forEach((line, i) => {
    const isCode = inBlockComment || looksLikeCode(lines, i, run.inDiff);
    inBlockComment = inBlockComment ? !line.includes("*/") : opensClosedBlockComment(lines, i);
    if (DIFF_HEADER.test(line)) run.inDiff = true;
    if (isCode) {
      if (run.first < 0) run.first = i;
      run.last = i;
      run.codeLines++;
    } else if (run.first >= 0 && continuesCode(line, run.inDiff)) {
      if (line.trim()) run.last = i;
    } else if (run.first >= 0) {
      closeRun();
    }
  });
  closeRun();
  return runs;
}

function looksLikeCode(lines: string[], i: number, inDiff: boolean): boolean {
  const line = lines[i];
  if (DIFF_HEADER.test(line)) return true;
  if (inDiff && DIFF_CHANGE.test(line)) return matchesCodePattern(line.slice(1));
  if (LIST_ITEM.test(line)) return false;
  if (BLOCK_HEADER.test(line)) return isFollowedByIndentedBody(lines, i);
  return matchesCodePattern(line);
}

/** A line starting "/*" opens a comment only if a later line closes it; "/*.log files" in prose doesn't. */
function opensClosedBlockComment(lines: string[], i: number): boolean {
  if (!/^\s*\/\*/.test(lines[i]) || lines[i].includes("*/")) return false;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].includes("*/")) return true;
  }
  return false;
}

function matchesCodePattern(line: string): boolean {
  return CODE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function isFollowedByIndentedBody(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim()) return /^\s/.test(lines[j]) && !LIST_ITEM.test(lines[j]);
  }
  return false;
}

function continuesCode(line: string, inDiff: boolean): boolean {
  if (!line.trim() || SQL_CLAUSE.test(line)) return true;
  if (inDiff && DIFF_CHANGE.test(line)) return true;
  return /^\s/.test(line) && !LIST_ITEM.test(line);
}
