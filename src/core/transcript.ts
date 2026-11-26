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
  /** Byte offset just past the turn's last source line, when parsed with a start offset. */
  endOffset?: number;
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

/**
 * Parse JSONL lines into turns. Unknown or malformed lines are skipped. With
 * `startOffset` (the byte position of the first line in its file), each turn records
 * where its last source line ends, so a reader can resume right after it.
 */
export function parseClaudeCodeLines(lines: string[], startOffset?: number): RawTurn[] {
  const turns: RawTurn[] = [];
  let position = startOffset ?? 0;
  for (const line of lines) {
    position += Buffer.byteLength(line, "utf8") + 1;
    const e = parseJsonLine(line);
    if (!e || !isConversationEntry(e)) continue;
    const text = entryText(e);
    if (!text) continue;
    appendTurn(turns, {
      author: e.type === "user" ? "human" : "ai",
      text,
      externalId: String(e.uuid ?? ""),
      timestamp: String(e.timestamp ?? new Date().toISOString()),
      session: String(e.sessionId ?? ""),
      endOffset: startOffset === undefined ? undefined : position,
    });
  }
  return turns;
}

/** Add turns read later (e.g. on the next poll), applying the same merge rule across reads. */
export function appendTurns(turns: RawTurn[], more: RawTurn[]): void {
  for (const turn of more) appendTurn(turns, turn);
}

/** Consecutive AI fragments (the text between an agent's tool calls) form one turn. */
function appendTurn(turns: RawTurn[], turn: RawTurn): void {
  const prev = turns[turns.length - 1];
  if (prev?.author === "ai" && turn.author === "ai") {
    prev.text += "\n" + turn.text;
    // Chunks of one source turn share an endOffset (see core/batches); move them all
    // together, or a batch could end between them and save an offset past unsent text.
    const oldEnd = prev.endOffset;
    for (let i = turns.length - 1; i >= 0 && turns[i].endOffset === oldEnd; i--) turns[i].endOffset = turn.endOffset;
    return;
  }
  turns.push({ ...turn });
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
  const encoded = comparablePath(workspace).replace(/[^a-zA-Z0-9]/g, "-");
  const files: string[] = [];
  for (const d of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const jsonl = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    if (comparableName(d) === encoded) {
      files.push(...jsonl);
      continue;
    }
    files.push(...jsonl.filter((f) => isSessionInWorkspace(f, workspace)));
  }
  return files;
}

/**
 * Whether `candidate` is `workspace` or inside it. On Windows the comparison ignores
 * case and accepts Git Bash paths ("/c/Users/..."), since Claude Code logs record the
 * same folder in all of these forms.
 */
export function isInsideWorkspace(candidate: string, workspace: string, platform = process.platform): boolean {
  const inner = comparablePath(candidate, platform);
  const outer = comparablePath(workspace, platform);
  const separator = platform === "win32" ? "\\" : "/";
  return inner === outer || inner.startsWith(outer.endsWith(separator) ? outer : outer + separator);
}

/** How much of a session file to scan for its recorded cwd. */
const SESSION_HEAD_BYTES = 8000;

/** Fallback when the folder name doesn't match: check the cwd recorded in the first lines. */
function isSessionInWorkspace(file: string, workspace: string): boolean {
  const m = readHead(file, SESSION_HEAD_BYTES).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  if (!m) return false;
  try {
    return isInsideWorkspace(JSON.parse(`"${m[1]}"`), workspace);
  } catch {
    return false; // malformed escape in the recorded cwd; treat the file as not ours
  }
}

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, bytes, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function comparablePath(p: string, platform = process.platform): string {
  if (platform !== "win32") return path.posix.resolve(p);
  const gitBash = p.match(/^\/([a-zA-Z])(\/.*)?$/);
  const native = gitBash ? `${gitBash[1]}:${gitBash[2] ?? "/"}` : p;
  return path.win32.resolve(native).toLowerCase();
}

function comparableName(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}
