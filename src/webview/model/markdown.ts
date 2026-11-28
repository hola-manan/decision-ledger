/**
 * A small, safe markdown subset → a token tree (D-012): paragraphs, headings, lists,
 * emphasis, inline code, fenced code and links. The view builds DOM from the tree with
 * textContent, so nothing here is ever HTML: raw HTML stays text, and a link is a link only
 * for http: and https: addresses. No DOM. Patterns can't backtrack badly, and searches that
 * came up empty are remembered, so adversarial input stays linear-ish.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "code"; lang: string | null; text: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
/** The text after the hashes; a closing run of # is removed by headingText, not by the pattern. */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const CONTINUATION = /^\s{2,}\S/;
const SAFE_LINK = /^https?:\/\//i;
/** Deeper emphasis than this is shown as text: no real reply needs it, and it bounds recursion. */
const MAX_NESTING = 8;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      endParagraph();
      i = readFence(lines, i, fence[1], fence[2] || null, blocks);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      endParagraph();
      blocks.push({ type: "heading", level: heading[1].length, inlines: parseInline(headingText(heading[2] ?? "")) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      endParagraph();
      i = readList(lines, i, blocks);
      continue;
    }
    if (!line.trim()) endParagraph();
    else paragraph.push(line.trim());
  }
  endParagraph();
  return blocks;
}

/** Without trailing spaces or a closing run of #, which only counts after a space ("C#" keeps its #). */
function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  return end === 0 || /\s/.test(text[end - 1]) ? text.slice(0, end).trimEnd() : text;
}

/** Up to the matching closing fence, or to the end when it is never closed. Returns the last line used. */
function readFence(lines: string[], start: number, marker: string, lang: string | null, blocks: Block[]): number {
  const body: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const close = lines[i].match(FENCE);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length && !close[2]) break;
    body.push(lines[i]);
  }
  blocks.push({ type: "code", lang, text: body.join("\n") });
  return i;
}

/** Consecutive items of one kind (bulleted or numbered); indented lines continue the item. Returns the last line used. */
function readList(lines: string[], start: number, blocks: Block[]): number {
  const ordered = /\d/.test(lines[start].match(LIST_ITEM)![1]);
  const items: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const item = lines[i].match(LIST_ITEM);
    if (item && /\d/.test(item[1]) === ordered) items.push(item[2]);
    else if (items.length && CONTINUATION.test(lines[i])) items[items.length - 1] += `\n${lines[i].trim()}`;
    else break;
  }
  blocks.push({ type: "list", ordered, items: items.map((text) => parseInline(text)) });
  return i - 1;
}

/**
 * indexOf that remembers where a search came up empty: any later search for the same text
 * from that point on is empty too. Unclosed markers then don't rescan to the end from every
 * position, which would be quadratic on adversarial input.
 */
class Scanner {
  private readonly missingFrom = new Map<string, number>();

  constructor(readonly text: string) {}

  find(needle: string, from: number): number {
    const missing = this.missingFrom.get(needle);
    if (missing !== undefined && from >= missing) return -1;
    const found = this.text.indexOf(needle, from);
    if (found < 0) this.missingFrom.set(needle, Math.min(from, missing ?? from));
    return found;
  }
}

type Token = { inline: Inline; end: number };

export function parseInline(text: string, depth = 0): Inline[] {
  const scanner = new Scanner(text);
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
  };
  for (let i = 0; i < text.length; ) {
    const token = depth < MAX_NESTING ? readToken(scanner, i, depth) : undefined;
    if (!token) {
      plain += text[i++];
      continue;
    }
    if (token.inline.type === "text") plain += token.inline.text;
    else {
      flush();
      out.push(token.inline);
    }
    i = token.end;
  }
  flush();
  return out;
}

function readToken(scanner: Scanner, i: number, depth: number): Token | undefined {
  const { text } = scanner;
  const ch = text[i];
  if (ch === "`") return readCode(scanner, i);
  if (ch === "[") return readLink(scanner, i, depth);
  if ((ch === "*" || ch === "_") && text[i + 1] === ch) return readDelimited(scanner, i, ch + ch, "strong", depth);
  if (ch === "*" || (ch === "_" && !isWordChar(text[i - 1]))) return readDelimited(scanner, i, ch, "em", depth);
  return undefined;
}

/** A run of backticks with no matching run later is text, taken whole so it isn't searched again. */
function readCode(scanner: Scanner, i: number): Token {
  const { text } = scanner;
  let ticks = 0;
  while (text[i + ticks] === "`") ticks++;
  const marker = "`".repeat(ticks);
  const close = scanner.find(marker, i + ticks);
  if (close < 0) return { inline: { type: "text", text: marker }, end: i + ticks };
  const inner = text.slice(i + ticks, close);
  return { inline: { type: "code", text: inner.trim() || inner }, end: close + ticks };
}

function readDelimited(scanner: Scanner, i: number, marker: string, type: "strong" | "em", depth: number): Token | undefined {
  const { text } = scanner;
  const start = i + marker.length;
  if (!text[start] || /\s/.test(text[start])) return undefined;
  const close = scanner.find(marker, start + 1);
  if (close < 0 || /\s/.test(text[close - 1])) return undefined;
  if (marker === "_" && isWordChar(text[close + 1])) return undefined; // snake_case_words aren't emphasis
  return { inline: { type, children: parseInline(text.slice(start, close), depth + 1) }, end: close + marker.length };
}

/** [label](address): a link only for http(s); otherwise the whole thing stays text. */
function readLink(scanner: Scanner, i: number, depth: number): Token | undefined {
  const { text } = scanner;
  const labelEnd = scanner.find("]", i + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return undefined;
  const hrefEnd = scanner.find(")", labelEnd + 2);
  if (hrefEnd < 0) return undefined;
  const href = text.slice(labelEnd + 2, hrefEnd).trim();
  const end = hrefEnd + 1;
  if (!SAFE_LINK.test(href) || /\s/.test(href)) return { inline: { type: "text", text: text.slice(i, end) }, end };
  return { inline: { type: "link", href, children: parseInline(text.slice(i + 1, labelEnd), depth + 1) }, end };
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}
