/**
 * Who the human in a conversation is. Chat logs don't say, so it's the person whose
 * machine records the conversation: their git name for the project, else their login.
 */
import { execFileSync } from "child_process";
import * as os from "os";

/** Used only when neither git nor the OS can name the user. */
export const UNKNOWN_HUMAN_NAME = "human";
/** Used when a log doesn't say which model wrote a message. */
export const UNKNOWN_AI_NAME = "ai";

const GIT_TIMEOUT_MS = 3000;

export function localHumanName(workspace: string): string {
  return gitUserName(workspace) || osUserName() || UNKNOWN_HUMAN_NAME;
}

function gitUserName(workspace: string): string {
  try {
    return execFileSync("git", ["config", "user.name"], { cwd: workspace, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return ""; // no git, no repo, or no name set: fall back to the OS login
  }
}

function osUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}
