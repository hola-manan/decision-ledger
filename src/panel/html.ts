/**
 * The panel webview's HTML shell (api.md §4). Pure: the controller passes the URIs and a
 * fresh nonce, so the CSP is tested without VS Code.
 */

export interface PanelHtmlInput {
  /** webview.cspSource: the only origin scripts, styles, fonts and images may come from. */
  cspSource: string;
  /** Fresh per render. */
  nonce: string;
  scriptUri: string;
  styleUris: string[];
}

export function panelHtml({ cspSource, nonce, scriptUri, styleUris }: PanelHtmlInput): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    // cspSource lets the entry module import its sibling modules; nothing inline, nothing remote.
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join("; ");
  const styles = styleUris.map((uri) => `  <link rel="stylesheet" href="${escapeAttribute(uri)}">`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${styles}
  <title>Live Session</title>
</head>
<body>
  <main id="root"><p class="status">Loading the session…</p></main>
  <script type="module" nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(scriptUri)}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
