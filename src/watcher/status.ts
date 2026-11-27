/** Extraction progress per session file, for the panel's "Extracting…" / "N decisions" / error states (D-010). */
import type { Unsubscribe } from "../claude-log";

export interface ExtractionStatus {
  enabled: boolean;
  /** Everything before it is in the ledger. */
  committedOffset: number;
  inFlight: { fromOffset: number; toOffset: number } | null;
  /** The domain error, converted for display by the panel. */
  failure: { error: unknown; retryAt: number | null } | null;
}

export interface ExtractionStatusProvider {
  status(file: string): ExtractionStatus;
  onDidChangeStatus(listener: (file: string) => void): Unsubscribe;
  /** Clears backoff and runs a pass immediately. */
  retryNow(): void;
}
