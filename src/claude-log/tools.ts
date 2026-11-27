/**
 * Tool inputs and results reduced to facts: paths, line counts, the command, the
 * questions. File contents, old/new strings, patches and tool output stop here.
 */
import type { AskedQuestion, FileChangeFact, ToolCall } from "./entries";

/** A9: the result text Claude Code writes when the person denies a tool. */
const DENIAL_PREFIX = "The user doesn't want to proceed with this tool use";
const SUB_AGENT_TOOLS = new Set(["Task", "Agent"]);
/** A command is shown, never run or sent; its first line is enough, and a heredoc body may be a whole file. */
export const MAX_COMMAND_CHARS = 200;

type Json = Record<string, unknown>;

/** A8: a tool_use block's input → a ToolCall. */
export function toToolCall(block: Json): ToolCall {
  const input = asObject(block.input);
  const tool = text(block.name) ?? "unknown";
  const call: ToolCall = { id: text(block.id) ?? "", tool };
  const file = text(input.file_path) ?? text(input.path) ?? text(input.notebook_path);
  if (file) call.file = file;
  const subAgent = SUB_AGENT_TOOLS.has(tool) ? text(input.description) : undefined;
  const target = text(input.file_path) ?? text(input.notebook_path) ?? text(input.url) ?? text(input.pattern) ?? text(input.path) ?? subAgent;
  if (target) call.target = target;
  const command = tool === "Bash" ? text(input.command) : undefined;
  if (command) call.command = firstLine(command, MAX_COMMAND_CHARS);
  if (text(input.description) && (tool === "Bash" || subAgent)) call.description = text(input.description);
  if (tool === "AskUserQuestion") call.questions = askedQuestions(input.questions);
  const edit = editFromInput(tool, input);
  if (edit) call.edit = edit;
  return call;
}

/** A9: whether a tool_result's text is Claude Code's denial notice. */
export function isDenial(content: unknown): boolean {
  return resultText(content).startsWith(DENIAL_PREFIX);
}

/** A7: toolUseResult → what changed in the file. Edit/MultiEdit/Write updates carry a structuredPatch; a Write create carries the new content. */
export function fileChangeFromResult(result: unknown): FileChangeFact | undefined {
  const r = asObject(result);
  const path = text(r.filePath);
  if (!path || !Array.isArray(r.structuredPatch)) return undefined;
  if (r.type === "create") return { path, kind: "added", added: countLines(text(r.content) ?? ""), removed: 0 };
  const counts = countPatch(r.structuredPatch);
  return { path, kind: "modified", ...counts };
}

/** A10: an answered AskUserQuestion's toolUseResult.answers, question → answer. */
export function answersFromResult(result: unknown): { question: string; answer: string }[] | undefined {
  const answers = asObject(result).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
  return Object.entries(answers as Json).map(([question, answer]) => ({ question, answer: Array.isArray(answer) ? answer.join(", ") : String(answer) }));
}

function editFromInput(tool: string, input: Json): FileChangeFact | undefined {
  const path = text(input.file_path);
  if (tool === "Edit" && path) return { path, kind: "modified", ...countReplace(input) };
  if (tool === "MultiEdit" && path) {
    const edits = Array.isArray(input.edits) ? input.edits.map(asObject).map(countReplace) : [];
    return { path, kind: "modified", added: sum(edits.map((e) => e.added)), removed: sum(edits.map((e) => e.removed)) };
  }
  if (tool === "Write" && path) return { path, kind: "modified", added: countLines(text(input.content) ?? "") };
  const notebook = text(input.notebook_path);
  if (tool === "NotebookEdit" && notebook) return { path: notebook, kind: "modified" };
  return undefined;
}

function countReplace(edit: Json): { added: number; removed: number } {
  return { added: countLines(text(edit.new_string) ?? ""), removed: countLines(text(edit.old_string) ?? "") };
}

function countPatch(hunks: unknown[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const lines = asObject(hunk).lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

function askedQuestions(value: unknown): AskedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.map(asObject).flatMap((q) => {
    const question = text(q.question);
    if (!question) return [];
    const options = (Array.isArray(q.options) ? q.options : []).map(asObject).flatMap((o) => {
      const label = text(o.label);
      return label ? [{ label, ...(text(o.description) ? { description: text(o.description) } : {}) }] : [];
    });
    return [{ question, ...(text(q.header) ? { header: text(q.header) } : {}), options, multiSelect: q.multiSelect === true }];
  });
}

/** A tool_result's content: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => text(asObject(b).text) ?? "").join("\n");
}

function firstLine(s: string, maxChars: number): string {
  const line = s.trim().split("\n")[0];
  return line.length > maxChars ? line.slice(0, maxChars - 1) + "…" : line;
}

export function countLines(s: string): number {
  if (!s) return 0;
  const lines = s.split("\n").length;
  return s.endsWith("\n") ? lines - 1 : lines;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
