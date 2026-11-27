/**
 * Elements Claude Code injects into "user" messages that the person never typed:
 * slash-command plumbing, reminders, sub-agent completion notices, and IDE context
 * (which can carry selected code). Stripped as whole elements so any prose the
 * person typed alongside them in the same block survives (A5).
 */
const HARNESS_ELEMENT =
  /<(command-[\w-]+|local-command-[\w-]+|system-reminder|task-notification|ide_[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g;

/** A11: Claude Code's note that the person stopped the reply. */
const INTERRUPT_MARKER = /\[Request interrupted by user[^\]]*\]/g;

export function withoutHarnessText(text: string): string {
  return text.replace(HARNESS_ELEMENT, "").replace(INTERRUPT_MARKER, "").trim();
}

export function hasInterruptMarker(text: string): boolean {
  return text.search(INTERRUPT_MARKER) >= 0;
}
