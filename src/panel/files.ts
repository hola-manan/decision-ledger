/**
 * "Files changed" for one exchange (data-model.md §2, `files`). Pure. Counts come from
 * Claude Code's own result when it has one, else from the tool input.
 */
import { comparablePath, type FileChangeFact } from "../claude-log";
import type { CallState, Exchange } from "./exchanges";

/** One row per file. Paths are absolute, as logged; view mapping makes them relative. */
export interface FileChange {
  path: string;
  kind: "added" | "modified";
  /** Lines; undefined when unknown (NotebookEdit). */
  added?: number;
  removed?: number;
}

/**
 * One row per path in the order files were first changed. Only calls that finished without
 * an error count (a denied call is an error too); a pending call doesn't count yet. Counts
 * are summed per path, and stay unknown once any change to the path has unknown counts.
 * `kind` is "added" when the first counted change created the file. Two spellings of one
 * path (Windows case or separators) are one row, shown as first spelled.
 */
export function collectFileChanges(exchange: Exchange): FileChange[] {
  const rows = new Map<string, FileChange>();
  for (const state of exchange.calls.values()) {
    const fact = countedChange(state);
    if (!fact) continue;
    const key = comparablePath(fact.path);
    const row = rows.get(key);
    if (!row) rows.set(key, withoutUndefined({ path: fact.path, kind: fact.kind, added: fact.added, removed: fact.removed }));
    else rows.set(key, withoutUndefined({ ...row, added: sum(row.added, fact.added), removed: sum(row.removed, fact.removed) }));
  }
  return [...rows.values()];
}

function countedChange({ call, result }: CallState): FileChangeFact | undefined {
  if (!result || result.isError || result.rejected) return undefined;
  return result.fileChange ?? call.edit;
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a + b;
}

function withoutUndefined(row: FileChange): FileChange {
  if (row.added === undefined) delete row.added;
  if (row.removed === undefined) delete row.removed;
  return row;
}
