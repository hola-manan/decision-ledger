/**
 * The decision section's state for one exchange (data-model.md §3, "Decision-section
 * state"). Pure: it reads the watcher's status, never the watcher itself.
 */
import { ConfigError, NoModelError } from "../core";
import type { ExtractionStatus } from "../watcher";
import type { Exchange } from "./exchanges";
import type { Phase } from "./phase";

export type DecisionSectionState = "notYet" | "extracting" | "done" | "failed" | "noModel" | "configInvalid" | "off";

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

function failureState(error: unknown): DecisionSectionState {
  if (error instanceof NoModelError) return "noModel";
  if (error instanceof ConfigError) return "configInvalid";
  return "failed";
}
