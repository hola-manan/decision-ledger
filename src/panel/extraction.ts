/**
 * The decision section's state for one exchange (data-model.md §3, "Decision-section
 * state"). Pure: it reads the watcher's status, never the watcher itself.
 */
import type { DecisionSectionState } from "../protocol";
import type { ExtractionStatus } from "../watcher";
import { toPanelError } from "./errors";
import type { Exchange } from "./exchanges";
import type { Phase } from "./phase";

export type { DecisionSectionState };

/**
 * Checked in order: watching off; reply still running; committed (the count may be 0);
 * failed and not committed; otherwise extracting. Whether "notYet" is shown at all
 * (only with decisions so far) is the view's call.
 */
export function sectionState(input: { exchange: Exchange; phase: Phase; status: ExtractionStatus }): DecisionSectionState {
  const { exchange, phase, status } = input;
  if (!status.enabled) return "off";
  if (phase.phase === "working") return "notYet";
  if (exchange.endOffset <= status.committedOffset) return "done";
  if (status.failure) return failureState(status.failure.error);
  return "extracting";
}

/** The failure's kind comes from toPanelError, so errors are classified in one place. */
function failureState(error: unknown): DecisionSectionState {
  const { code } = toPanelError(error);
  if (code === "NO_MODEL") return "noModel";
  if (code === "LEDGER_CONFIG_INVALID") return "configInvalid";
  return "failed";
}
