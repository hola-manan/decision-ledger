// Copies the webviews' stylesheets next to their compiled scripts (tsconfig.webview.json → out/browser).
import { cpSync } from "fs";

const from = new URL("../src/webview/", import.meta.url);
const to = new URL("../out/browser/webview/", import.meta.url);
cpSync(from, to, { recursive: true, filter: (source) => !source.endsWith(".ts") });
