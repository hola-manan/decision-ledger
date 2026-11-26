/**
 * Commits a backlog of turns to the ledger in batches, so a failure part-way loses
 * nothing and repeats nothing: committed turns leave the backlog, and after each batch
 * the caller learns the source offset that is now safe to persist.
 *
 * One exception: a single source turn too long for one batch (more than a batch of
 * chunks) has no safe offset until it is fully committed, so a reload in the middle of
 * it repeats its already-committed chunks.
 */
import type { Ledger } from "./store";
import type { Complete } from "./engine";
import type { RawTurn } from "./transcript";
import { ingest, IngestMeta } from "./ingest";

export interface BatchCommitted {
  turns: number;
  result: Awaited<ReturnType<typeof ingest>>;
  /** Everything in the source before this offset is in the ledger; undefined if unknown. */
  safeOffset: number | undefined;
}

/**
 * Ingests `backlog` front to back, removing each batch once committed. Batches end on
 * a source-turn boundary where possible (chunks of one long turn share an endOffset),
 * so the reported safe offset never points into a half-committed turn.
 */
export async function ingestBacklog(
  ledger: Ledger,
  backlog: RawTurn[],
  complete: Complete,
  meta: IngestMeta,
  maxTurnsPerBatch: number,
  onCommitted: (batch: BatchCommitted) => void
): Promise<void> {
  while (backlog.length) {
    const size = batchSize(backlog, maxTurnsPerBatch);
    const batch = backlog.slice(0, size);
    const result = await ingest(ledger, batch, complete, meta);
    backlog.splice(0, size);
    const endsOnBoundary = !backlog.length || backlog[0].endOffset !== batch[size - 1].endOffset;
    onCommitted({ turns: size, result, safeOffset: endsOnBoundary ? batch[size - 1].endOffset : undefined });
  }
}

/** Up to `max` turns, shortened to end where one source turn ends and the next begins. */
export function batchSize(turns: RawTurn[], max: number): number {
  if (turns.length <= max) return turns.length;
  for (let n = max; n > 0; n--) {
    if (turns[n - 1].endOffset !== turns[n].endOffset) return n;
  }
  return max; // a single source turn longer than a whole batch
}
