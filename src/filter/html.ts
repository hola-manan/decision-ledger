/** The Filter view's HTML shell: our own styles and one script, nothing remote (CSP). */
import * as vscode from "vscode";
import { randomBytes } from "crypto";

const NONCE_BYTES = 16;
/** Built by tsconfig.webview.json and scripts/copy-webview-assets.mjs. */
export const WEBVIEW_OUT_DIR = ["out", "browser"];

export function filterHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...WEBVIEW_OUT_DIR, ...parts));
  const nonce = randomBytes(NONCE_BYTES).toString("base64");
  const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}' ${webview.cspSource}`].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${asset("webview", "styles", "tokens.css")}">
  <link rel="stylesheet" href="${asset("webview", "filter", "filter.css")}">
  <title>Grade filter</title>
</head>
<body>
  <main id="root"><p class="status">Loading parameters…</p></main>
  <script type="module" nonce="${nonce}" src="${asset("webview", "filter", "main.js")}"></script>
</body>
</html>`;
}
