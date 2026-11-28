import { test } from "node:test";
import assert from "node:assert/strict";
import { panelHtml } from "../src/panel/html";

const input = (nonce: string) => ({
  cspSource: "https://file+.vscode-resource.vscode-cdn.net",
  nonce,
  scriptUri: "https://file+.vscode-resource.vscode-cdn.net/ext/out/browser/webview/main.js",
  styleUris: ["https://file+.vscode-resource.vscode-cdn.net/ext/out/browser/webview/styles/tokens.css"],
});

function csp(html: string): string {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(match, "a CSP meta tag");
  return match[1];
}

test("html: a strict CSP: nothing by default, the nonce'd entry script, our own origin only", () => {
  const html = panelHtml(input("abc123"));
  const policy = csp(html);
  assert.match(policy, /^default-src 'none'/);
  assert.match(policy, /script-src 'nonce-abc123' https:\/\/file\+\.vscode-resource\.vscode-cdn\.net/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(policy, /(^|\s)https?:(\s|;|$)|\*/, "no scheme-wide or wildcard sources");
  assert.match(html, /<script type="module" nonce="abc123" src="https:\/\/file\+\.vscode-resource[^"]*main\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*nonce="abc123")/, "every script carries the nonce");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
});

test("html: each render uses the nonce it is given, and attribute values are escaped", () => {
  assert.notEqual(csp(panelHtml(input("first"))), csp(panelHtml(input("second"))));
  const html = panelHtml({ ...input("n"), scriptUri: 'x" onload="alert(1)' });
  assert.ok(!html.includes('onload="alert(1)"'));
});
