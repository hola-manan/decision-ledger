/**
 * The two edges of the panel protocol (api.md §1, "Validation at both edges"). The webview
 * runs parseHostMessage on everything it receives; the extension runs parseWebviewMessage.
 * An invalid message is dropped and reported, never half-used.
 */
import { MAX_SNAPSHOT_EXCHANGES, RESERVED_WEBVIEW_TYPES, SIMPLE_ACTIONS, type HostMessage, type SimpleActionType, type WebviewMessage } from "./messages.js";
import { array, bool, InvalidMessage, isPlainObject, nonEmptyStr, nullable, object, str, tagged, type Check, type Checked, type Same } from "./schema.js";
import { exchangeView, ledgerView, panelError, sessionView } from "./view-checks.js";
import { PROTOCOL_VERSION } from "./version.js";

export type ParseResult<T> =
  | { ok: true; message: T }
  /** `requestId` is set when one could be read, so the host can answer INVALID_MESSAGE. `version` is the `v` received, if not ours. */
  | { ok: false; reason: string; receivedType: string | null; requestId: string | null; version: number | null };

const hostMessage = tagged("type", {
  snapshot: object({
    session: nullable(sessionView),
    exchanges: array(exchangeView),
    hasEarlier: bool,
    ledger: ledgerView,
    problem: nullable(panelError),
  }),
  exchangeUpserted: object({ exchange: exchangeView }),
  exchangesPrepended: object({ exchanges: array(exchangeView), hasEarlier: bool }),
  actionResult: object({ requestId: nonEmptyStr, ok: bool, error: nullable(panelError) }),
});

const withRequestId = <S extends Record<string, Check<unknown>>>(shape: S) => object({ requestId: nonEmptyStr, ...shape });

const simpleActions = Object.fromEntries(SIMPLE_ACTIONS.map((type) => [type, withRequestId({})])) as Record<SimpleActionType, Check<{ requestId: string }>>;

const webviewMessage = tagged("type", {
  ready: object({}),
  ...simpleActions,
  openRecord: withRequestId({ recordId: nonEmptyStr }),
  revealNode: withRequestId({ nodeId: nonEmptyStr }),
  openFile: withRequestId({ exchangeId: nonEmptyStr, path: nonEmptyStr }),
  loadEarlier: withRequestId({ beforeExchangeId: nonEmptyStr }),
  protocolError: object({ receivedType: nullable(str), reason: str }),
  reloadRequest: object({}),
});

export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  return parse(raw, (value) => {
    const message = hostMessage(value, "message");
    if (message.type === "snapshot" && message.exchanges.length > MAX_SNAPSHOT_EXCHANGES) {
      throw new InvalidMessage(`message.exchanges: at most ${MAX_SNAPSHOT_EXCHANGES} in a snapshot`);
    }
    return message;
  });
}

export function parseWebviewMessage(raw: unknown): ParseResult<WebviewMessage> {
  return parse(raw, (value) => {
    const type = isPlainObject(value) ? value.type : undefined;
    if (typeof type === "string" && RESERVED_WEBVIEW_TYPES.includes(type)) throw new InvalidMessage(`message.type: "${type}" is reserved and not accepted yet`);
    return webviewMessage(value, "message");
  });
}

/** A message without its envelope, which parse adds back. */
type Payload<M> = M extends unknown ? Omit<M, "v"> : never;

// The checks produce exactly the message types, minus the envelope: drift fails to compile.
export const CHECKS_MATCH_MESSAGES: [Same<Checked<typeof hostMessage>, Payload<HostMessage>>, Same<Checked<typeof webviewMessage>, Payload<WebviewMessage>>] = [true, true];

function parse<M extends { v: number }>(raw: unknown, check: (value: unknown) => Payload<M>): ParseResult<M> {
  const receivedType = isPlainObject(raw) && typeof raw.type === "string" ? raw.type : null;
  const requestId = isPlainObject(raw) && typeof raw.requestId === "string" && raw.requestId ? raw.requestId : null;
  const failure = (reason: string, version: number | null = null) => ({ ok: false as const, reason, receivedType, requestId, version });
  if (!isPlainObject(raw)) return failure("message: expected an object");
  if (raw.v !== PROTOCOL_VERSION) {
    return failure(`message.v: expected ${PROTOCOL_VERSION}, got ${JSON.stringify(raw.v)}`, typeof raw.v === "number" ? raw.v : null);
  }
  try {
    // The payload plus the envelope is the message; TypeScript can't see that through the generic.
    return { ok: true, message: { v: PROTOCOL_VERSION, ...check(raw) } as unknown as M };
  } catch (error) {
    if (error instanceof InvalidMessage) return failure(error.message);
    throw error;
  }
}
