/**
 * Prepares turns for extraction: long turns are split into several turns instead of
 * truncated, so a decision near the end of a long agent run still reaches the model.
 */
import { stripCode } from "./code";
import type { RawTurn } from "./transcript";

/**
 * Code is stripped before splitting: a split inside a fenced block would leave its
 * second half without an opening fence, and that half would then read as prose.
 */
export function chunkTurns(turns: RawTurn[], maxChars: number): RawTurn[] {
  return turns.flatMap((turn) => splitText(stripCode(turn.text), maxChars).map((text) => ({ ...turn, text })));
}

/** Pieces of at most `maxChars`, cut at a paragraph break, line break or space where possible. */
export function splitText(text: string, maxChars: number): string[] {
  if (maxChars < 1) throw new RangeError(`maxChars must be at least 1, got ${maxChars}`);
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const cut = cutPoint(rest, maxChars);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Natural breaks only count in the second half of the window, so chunks don't come out tiny. */
function cutPoint(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars);
  for (const separator of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(separator);
    if (at >= maxChars / 2) return at;
  }
  return maxChars;
}
