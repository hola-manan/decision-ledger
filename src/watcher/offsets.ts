/** The watcher's saved progress: per session file, everything before `offset` is in the ledger. */
import type { Ledger } from "../core";

export const WATCH_STATE_FILE = "watch.json";

export interface FileProgress {
  offset: number;
}

export type WatchState = Record<string, FileProgress>;

/** Entries that aren't a non-negative offset are dropped, so a hand-edited file can't break the watcher. */
export function readWatchState(ledger: Ledger): WatchState {
  const raw = ledger.readMeta<unknown>(WATCH_STATE_FILE, {});
  const state: WatchState = {};
  if (!raw || typeof raw !== "object") return state;
  for (const [file, value] of Object.entries(raw)) {
    const offset = (value as Partial<FileProgress> | null)?.offset;
    if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) state[file] = { offset };
  }
  return state;
}

export function writeWatchState(ledger: Ledger, state: WatchState): void {
  ledger.writeMeta(WATCH_STATE_FILE, state);
}
