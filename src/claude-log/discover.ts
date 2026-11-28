/**
 * A1: Claude Code writes each session to ~/.claude/projects/<slug>/<sessionId>.jsonl,
 * where the slug is the cwd with non-alphanumerics replaced by "-". When the folder name
 * doesn't match, the cwd recorded in the file's first lines decides. Sub-agent logs live
 * one level deeper (<slug>/<sessionId>/subagents/) and are ignored.
 */
import * as fs from "fs";
import * as path from "path";

/** How much of a session file to scan for its recorded cwd. */
const SESSION_HEAD_BYTES = 8000;
const SESSION_EXTENSION = ".jsonl";

/**
 * Session files whose recorded cwd is inside `workspace`. `memo` remembers the answer per
 * file across calls: once a file records its cwd, that never changes, so its head is read once.
 */
export function findSessionFiles(projectsDir: string, workspace: string, memo?: Map<string, boolean>): string[] {
  if (!fs.existsSync(projectsDir)) return [];
  const encoded = comparablePath(workspace).replace(/[^a-zA-Z0-9]/g, "-");
  const files: string[] = [];
  for (const d of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const jsonl = fs.readdirSync(dir).filter((f) => f.endsWith(SESSION_EXTENSION)).map((f) => path.join(dir, f));
    if (comparableName(d) === encoded) {
      files.push(...jsonl);
      continue;
    }
    files.push(...jsonl.filter((f) => remembered(memo, f, () => isSessionInWorkspace(f, workspace))));
  }
  return files;
}

/** The session id is the file's basename (A12). */
export function sessionIdOf(file: string): string {
  return path.basename(file, SESSION_EXTENSION);
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

/** `decide` returns undefined while the file records no cwd yet; that isn't remembered. */
function remembered(memo: Map<string, boolean> | undefined, file: string, decide: () => boolean | undefined): boolean {
  const known = memo?.get(file);
  if (known !== undefined) return known;
  const answer = decide();
  if (answer !== undefined) memo?.set(file, answer);
  return answer ?? false;
}

/** Fallback when the folder name doesn't match: check the cwd recorded in the first lines. Undefined: no cwd yet. */
function isSessionInWorkspace(file: string, workspace: string): boolean | undefined {
  const m = readHead(file, SESSION_HEAD_BYTES).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  if (!m) return undefined;
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

/** A path as logged, in a form two spellings of the same file share (Windows: case, separators, Git Bash /c/ paths). */
export function comparablePath(p: string, platform = process.platform): string {
  if (platform !== "win32") return path.posix.resolve(p);
  const gitBash = p.match(/^\/([a-zA-Z])(\/.*)?$/);
  const native = gitBash ? `${gitBash[1]}:${gitBash[2] ?? "/"}` : p;
  return path.win32.resolve(native).toLowerCase();
}

function comparableName(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}
