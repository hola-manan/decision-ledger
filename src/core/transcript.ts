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

/** Parse JSONL lines into turns. Unknown or malformed lines are skipped. */
export function parseClaudeCodeLines(lines: string[]): RawTurn[] {
  const out: RawTurn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain || e.isMeta) continue;
    const content = e.message?.content;
    const parts: string[] = [];
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c?.type === "tool_use") parts.push(describeTool(c.name, c.input));
        // tool_result, thinking, images: skipped
      }
    }
    const text = parts.filter(Boolean).join("\n").trim();
    if (!text || /^<(command|local-command|system-reminder)/.test(text)) continue;
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
