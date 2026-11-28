/** Durations and times as the panel writes them (docs/ui/chat-panel.md, "Copy reference"). No DOM. */
import type { ResponseView } from "../../protocol/index.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "41s", "3m 41s", "1h 2m". */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "0:41", "3:41", "1:02:03": the clock style used for interrupted replies and the live timer. */
export function durationClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The response header: "Working", "Done in 3m 41s", "Stopped by you after 0:41", … */
export function headerText(response: Pick<ResponseView, "phase" | "endReason" | "durationMs">): string {
  if (response.phase === "working") return "Working";
  const ms = response.durationMs;
  switch (response.endReason) {
    case "stoppedByUser":
      return ms === null ? "Stopped by you" : `Stopped by you after ${durationClock(ms)}`;
    case "error":
      return ms === null ? "Stopped by an error" : `Stopped by an error after ${durationClock(ms)}`;
    case "incomplete":
      return "Unfinished: Claude Code stopped writing to this reply";
    default:
      return ms === null ? "Done" : `Done in ${durationWords(ms)}`;
  }
}

/** "just now", "2m ago", "3h ago", "2d ago". */
export function ago(ms: number): string {
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}
