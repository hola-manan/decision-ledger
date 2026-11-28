/**
 * The Live Session webview's entry point: one store, one bridge, and a render of the
 * whole-panel state. Runs in the browser.
 */
import { connect } from "./bridge.js";
import { EMPTY_STORE, reduce, type StoreEvent } from "./model/store.js";
import { button, element } from "./view/dom.js";
import { exchangeSummaryView } from "./view/exchange-summary.js";
import { emptySessionView, loadingView, problemView, sessionLine } from "./view/states.js";

const root = document.getElementById("root") as HTMLElement;
let store = EMPTY_STORE;

const bridge = connect(
  (message) => update({ kind: "message", message }),
  (received) => update({ kind: "versionMismatch", received })
);

function update(event: StoreEvent): void {
  store = reduce(store, event);
  render();
}

function render(): void {
  if (store.problem) return show(problemView(store.problem, bridge.send, bridge.reload), ...actionErrorView());
  if (!store.hasSnapshot) return show(loadingView());
  if (!store.session) return show(loadingView());
  const parts: HTMLElement[] = [sessionLine(store.session, Date.now(), bridge.send)];
  if (store.hasEarlier && store.exchanges[0]) {
    const first = store.exchanges[0].id;
    parts.push(button("Show earlier replies", "text", () => bridge.send({ type: "loadEarlier", beforeExchangeId: first })));
  }
  if (store.exchanges.length === 0) parts.push(emptySessionView(store.ledger));
  else parts.push(...store.exchanges.map(exchangeSummaryView));
  parts.push(...actionErrorView());
  show(...parts);
}

/** What the last failed button press said, if anything. */
function actionErrorView(): HTMLElement[] {
  if (!store.actionError) return [];
  const message = element("p", "action-error", store.actionError.message);
  message.setAttribute("role", "alert");
  return [message];
}

function show(...nodes: HTMLElement[]): void {
  root.replaceChildren(...nodes);
}
