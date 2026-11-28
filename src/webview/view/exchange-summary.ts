/**
 * A compact view of one exchange: the prompt, how the reply is going, and the decision
 * count. Build step 17 replaces it with the full layout (question, permission, decisions,
 * files, full reply).
 */
import type { ExchangeView } from "../../protocol/index.js";
import { SECTION_TEXT, waitingText } from "../model/copy.js";
import { headerText } from "../model/format.js";
import { element } from "./dom.js";

export function exchangeSummaryView(exchange: ExchangeView): HTMLElement {
  const { response, decisions } = exchange;
  const box = element("article", "exchange");
  box.dataset.id = exchange.id;
  box.append(element("p", "exchange-prompt", exchange.prompt.text));
  const status = response.waiting ? waitingText(response.waiting) : response.activity ?? headerText(response);
  box.append(element("p", `exchange-status${response.waiting ? " exchange-status-waiting" : ""}`, status));
  if (response.errorText) box.append(element("p", "exchange-error", response.errorText));
  const count = decisions.items.length;
  const label = decisions.state === "done" ? (count === 1 ? "1 decision" : `${count} decisions`) : SECTION_TEXT[decisions.state];
  if (decisions.state !== "notYet" || count > 0) box.append(element("p", "exchange-decisions", label));
  return box;
}
