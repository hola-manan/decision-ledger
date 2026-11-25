/**
 * Reads autonomous-agent trails (Claude Code session logs, ~/.claude/projects/<dir>/<session>.jsonl)
 * and turns them into human/ai turns. Code is dropped: tool inputs that write files
 * become a one-line note, tool results are ignored.
 */
import * as fs from "fs";
import * as path from "path";
import type { Author } from "./store";

export interface RawTurn {
  author: Author;
  text: string;
  externalId: string;
  timestamp: string;
  session: string;
}

function describeTool(name: string, input: any): string {
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (file) return `[${name} ${path.basename(String(file))}]`;
  if (name === "Bash" && input?.description) return `[ran: ${input.description}]`;
  if (name === "TodoWrite" || name === "TaskCreate") return "";
  return `[${name}]`;
}

/**
 * Elements Claude Code injects into "user" messages that the human never typed:
 * slash-command plumbing, reminders, subagent completion notices, and IDE context
 * (which can carry selected code). Stripped as whole elements so any prose the
 * human typed alongside them in the same block survives.
 */
const HARNESS_ELEMENT =
  /<(command-[\w-]+|local-command-[\w-]+|system-reminder|task-notification|ide_[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g;
const INTERRUPT_MARKER = /\[Request interrupted by user[^\]]*\]/g;

/** Parse JSONL lines into turns. Unknown or malformed lines are skipped. */
export function parseClaudeCodeLines(lines: string[]): RawTurn[] {
  const out: RawTurn[] = [];
  for (const line of lines) {
    const e = parseJsonLine(line);
    if (!e || !isConversationEntry(e)) continue;
    const text = entryText(e);
    if (!text) continue;
    const author: Author = e.type === "user" ? "human" : "ai";
    const prev = out[out.length - 1];
    // Merge consecutive assistant fragments into one turn.
    if (prev && prev.author === author && author === "ai") {
      prev.text += "\n" + text;
      continue;
    }
    out.push({
      author,
      text,
      externalId: String(e.uuid ?? ""),
      timestamp: String(e.timestamp ?? new Date().toISOString()),
      session: String(e.sessionId ?? ""),
    });
  }
  return out;
}

function parseJsonLine(line: string): any {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** A main-thread user/assistant message that belongs in the conversation. */
function isConversationEntry(e: any): boolean {
  if (e.type !== "user" && e.type !== "assistant") return false;
  if (e.isSidechain || e.isMeta) return false;
  // Context-compaction summaries are AI-written recaps stored as "user" entries.
  if (e.isCompactSummary || e.isVisibleInTranscriptOnly) return false;
  if (e.type === "assistant") return true;
  // Newer logs tag where a user message came from; only "human" ones were typed by the person.
  // Deliberately an allowlist: unknown future kinds are rejected rather than credited to the human.
  // Older logs have no tag, so those rely on harness-text stripping instead.
  const originKind = e.origin?.kind;
  return originKind === undefined || originKind === "human";
}

/** The entry's prose plus one-line tool notes. Tool results, thinking, images and harness text are dropped. */
function entryText(e: any): string {
  const parts: string[] = [];
  for (const block of contentBlocks(e.message?.content)) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(withoutHarnessText(block.text));
    } else if (block?.type === "tool_use") {
      parts.push(describeTool(block.name, block.input));
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function contentBlocks(content: unknown): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function withoutHarnessText(text: string): string {
  return text.replace(HARNESS_ELEMENT, "").replace(INTERRUPT_MARKER, "").trim();
}

/** Find Claude Code session files whose recorded cwd is inside `workspace`. */
export function findSessionFiles(projectsDir: string, workspace: string): string[] {
  if (!fs.existsSync(projectsDir)) return [];
  const ws = path.resolve(workspace);
  const encoded = ws.replace(/[^a-zA-Z0-9]/g, "-");
  const files: string[] = [];
  for (const d of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const jsonl = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    if (d === encoded) {
      files.push(...jsonl);
      continue;
    }
    // Fallback: check the cwd recorded in the first lines.
    for (const f of jsonl) {
      const head = fs.readFileSync(f, "utf8").slice(0, 8000);
      const m = head.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (m && path.resolve(JSON.parse(`"${m[1]}"`)).startsWith(ws)) files.push(f);
    }
  }
  return files;
}
