/** The one error shape in the panel protocol (api.md §2). */

export const PANEL_ERROR_CODES = [
  "NO_SESSION_FOUND",
  "SESSION_UNREADABLE",
  "LOG_FORMAT_UNRECOGNIZED",
  "LEDGER_UNREADABLE",
  "EXTRACTION_API_FAILED",
  "EXTRACTION_REPLY_UNREADABLE",
  "NO_MODEL",
  "LEDGER_CONFIG_INVALID",
  "EXTRACTION_FAILED",
  "EXTRACTION_OFF",
  "NOT_FOUND",
  "ACTION_FAILED",
  "INVALID_MESSAGE",
  "PROTOCOL_VERSION_MISMATCH",
] as const;
export type PanelErrorCode = (typeof PANEL_ERROR_CODES)[number];

/** Buttons the webview can offer for an error; each is also a webview action. */
export const PANEL_ACTIONS = [
  "retryExtraction",
  "setUpModel",
  "editParameters",
  "enableExtraction",
  "rescanSessions",
  "chooseSession",
  "openOutput",
] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export interface PanelError {
  code: PanelErrorCode;
  /** One plain sentence of facts, written by the extension. Never a key, a model reply or a stack. */
  message: string;
  details: Record<string, string | number | boolean> | null;
  /** In order; the first is the primary button. */
  actions: PanelAction[];
}
