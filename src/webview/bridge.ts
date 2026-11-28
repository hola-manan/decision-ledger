/**
 * The webview's only link to the extension: every message in is validated (api.md §1),
 * every action out gets a requestId. Runs in the browser.
 */
import { parseHostMessage, PROTOCOL_VERSION, type HostMessage, type SimpleActionType, type WebviewMessage } from "../protocol/index.js";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

/** An action the webview can send, without its envelope and requestId. */
export type ActionRequest =
  | { type: SimpleActionType }
  | { type: "openRecord"; recordId: string }
  | { type: "revealNode"; nodeId: string }
  | { type: "openFile"; exchangeId: string; path: string }
  | { type: "loadEarlier"; beforeExchangeId: string };

export interface Bridge {
  send(action: ActionRequest): void;
  /** Ask the extension to re-render the webview (after a version mismatch). */
  reload(): void;
}

export function connect(onMessage: (message: HostMessage) => void, onVersionMismatch: (received: number | null) => void): Bridge {
  const vscode = acquireVsCodeApi();
  let nextRequest = 0;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const parsed = parseHostMessage(event.data);
    if (parsed.ok) return onMessage(parsed.message);
    // The person reloads with the button: reloading by itself could loop if the mismatch persisted.
    if (parsed.version !== null) return onVersionMismatch(parsed.version);
    vscode.postMessage({ v: PROTOCOL_VERSION, type: "protocolError", receivedType: parsed.receivedType, reason: parsed.reason });
  });
  vscode.postMessage({ v: PROTOCOL_VERSION, type: "ready" });
  return {
    send: (action) => vscode.postMessage({ v: PROTOCOL_VERSION, requestId: `r${++nextRequest}`, ...action } as WebviewMessage),
    reload: () => vscode.postMessage({ v: PROTOCOL_VERSION, type: "reloadRequest" }),
  };
}
