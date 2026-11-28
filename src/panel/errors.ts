/**
 * The one place a domain error becomes a PanelError (api.md §2). Messages are written here,
 * from facts only: never an error's own text when it could carry a key, a model reply, a
 * provider's response body or a stack.
 */
import { ApiError, ConfigError, ModelOutputError, NoModelError } from "../core";
import type { PanelAction, PanelError } from "../protocol";

/** Where the error happened, which decides the code for errors that aren't specific to one place. */
export type ErrorScope = "section" | "session" | "ledger";

export interface ErrorContext {
  scope?: ErrorScope;
  /** When the watcher will try again (epoch ms), if it will. */
  retryAt?: number | null;
}

const KEY_REJECTED_STATUSES = new Set([401, 403]);
const RATE_LIMITED_STATUS = 429;
const SERVER_ERROR_MIN = 500;
const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", gemini: "Vertex AI (Gemini)" };
/** fs error codes worth naming; anything else is "can't be read". */
const FS_REASONS: Record<string, string> = { ENOENT: "it no longer exists", EACCES: "permission was denied", EPERM: "permission was denied", EBUSY: "it is in use" };

export function toPanelError(error: unknown, context: ErrorContext = {}): PanelError {
  const scope = context.scope ?? "section";
  const retry: Record<string, string> = context.retryAt ? { retryAt: new Date(context.retryAt).toISOString() } : {};
  if (error instanceof ApiError) return apiFailed(error, retry);
  if (error instanceof ModelOutputError) {
    return panelError("EXTRACTION_REPLY_UNREADABLE", "The model's reply couldn't be read as decisions.", retry, ["retryExtraction"]);
  }
  if (error instanceof NoModelError) return panelError("NO_MODEL", "No model is set up for extraction.", null, ["setUpModel", "retryExtraction"]);
  if (error instanceof ConfigError) return panelError("LEDGER_CONFIG_INVALID", error.message, null, ["editParameters", "retryExtraction"]);
  const reason = fsReason(error);
  if (scope === "session") return panelError("SESSION_UNREADABLE", `The Claude Code session log can't be read: ${reason}.`, { reason }, ["rescanSessions", "chooseSession"]);
  if (scope === "ledger") return panelError("LEDGER_UNREADABLE", `The ledger in .ledger can't be read: ${reason}.`, { reason }, ["openOutput"]);
  return panelError("EXTRACTION_FAILED", "Extraction failed. The details are in the Decision Ledger output.", retry, ["retryExtraction", "openOutput"]);
}

function apiFailed(error: ApiError, retry: Record<string, string>): PanelError {
  const provider = PROVIDER_NAMES[error.provider] ?? error.provider;
  const isKeyRejected = KEY_REJECTED_STATUSES.has(error.status);
  const actions: PanelAction[] = isKeyRejected ? ["setUpModel", "retryExtraction"] : ["retryExtraction"];
  const message = `The ${provider} API ${statusMeaning(error.status)} (${error.status}).`;
  return panelError("EXTRACTION_API_FAILED", message, { provider: error.provider, status: error.status, ...retry }, actions);
}

function statusMeaning(status: number): string {
  if (KEY_REJECTED_STATUSES.has(status)) return "rejected the key";
  if (status === RATE_LIMITED_STATUS) return "is rate limiting requests";
  if (status >= SERVER_ERROR_MIN) return "is unavailable";
  return "refused the request";
}

function fsReason(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return (typeof code === "string" && FS_REASONS[code]) || "it can't be read";
}

function panelError(code: PanelError["code"], message: string, details: PanelError["details"], actions: PanelAction[]): PanelError {
  return { code, message, details: details && Object.keys(details).length ? details : null, actions };
}
