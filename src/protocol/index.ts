// Grade filter view (D-021).
export {
  parseFilterHostMessage,
  parseFilterMessage,
  type FilterHostMessage,
  type FilterParameter,
  type FilterState,
  type FilterWebviewMessage,
  type GradeRange,
} from "./filter.js";

// Companion panel (api.md §1–2).
export { PROTOCOL_VERSION } from "./version.js";
export { PANEL_ACTIONS, PANEL_ERROR_CODES, type PanelAction, type PanelError, type PanelErrorCode } from "./errors.js";
export {
  MAX_SNAPSHOT_EXCHANGES,
  RESERVED_WEBVIEW_TYPES,
  SESSION_TITLE_MAX_CHARS,
  SIMPLE_ACTIONS,
  type ActionResultMessage,
  type ExchangeUpsertedMessage,
  type ExchangesPrependedMessage,
  type HostMessage,
  type SimpleActionType,
  type SnapshotMessage,
  type WebviewMessage,
} from "./messages.js";
export type * from "./views.js";
export { parseHostMessage, parseWebviewMessage, type ParseResult } from "./validate.js";
