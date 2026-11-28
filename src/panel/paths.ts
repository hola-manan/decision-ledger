/** How a logged path is shown in the panel: relative to the workspace, else absolute; always with "/". */
import * as path from "path";
import { nativePath } from "../claude-log";

export function displayPath(file: string, workspace: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const root = nativePath(workspace, platform);
  // A relative path (Grep and Glob can log one) is relative to the workspace, not to VS Code's own folder.
  const absolute = paths.isAbsolute(file) ? nativePath(file, platform) : paths.resolve(root, file);
  // path.win32.relative compares case-insensitively and keeps the file's own casing.
  const relative = paths.relative(root, absolute);
  const isInside = relative !== "" && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  return (isInside ? relative : absolute).replace(/\\/g, "/");
}
