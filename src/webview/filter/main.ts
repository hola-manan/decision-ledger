/**
 * The grade filter's sliders (docs/ui/filter.md). Runs in the webview: it draws what the
 * extension sends and reports handle moves. Text goes in with textContent only.
 *
 * The sliders are built once per parameter set and then updated in place, so a refresh
 * from the extension never interrupts a drag, moves focus, or replaces the live count.
 */
import { parseFilterHostMessage, type FilterParameter, type FilterState, type FilterWebviewMessage, type GradeRange } from "../../protocol/filter.js";

declare function acquireVsCodeApi(): { postMessage(message: FilterWebviewMessage): void };

type Handle = "min" | "max";

interface SliderView {
  block: HTMLElement;
  parameter: FilterParameter;
  inputs: Record<Handle, HTMLInputElement>;
  value: HTMLElement;
  track: HTMLElement;
  /** The grade both handles sat on when this move started, if they were together. */
  together: number | undefined;
  /** The range the extension last knew about; a move is reported only when it differs. */
  lastSent: GradeRange;
}

interface StripView {
  key: string;
  sliders: SliderView[];
  count: HTMLElement;
  reset: HTMLButtonElement;
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("root") as HTMLElement;
let strip: StripView | undefined;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = parseFilterHostMessage(event.data);
  if (!message) return; // not from our extension, or from a different build
  if (message.type === "error") return showError(message.message);
  showState(message);
});
vscode.postMessage({ type: "ready" });

function showState(state: FilterState): void {
  const key = JSON.stringify([state.scale, state.parameters]);
  if (strip?.key !== key) strip = buildStrip(state, key);
  for (const slider of strip.sliders) updateSlider(slider, state.ranges[slider.parameter.id] ?? state.scale, state.scale, state.total === 0);
  strip.count.textContent = state.total === 0 ? "No decisions yet" : `Showing ${state.shown} of ${state.total} decisions`;
  strip.reset.hidden = !state.isActive;
}

function showError(message: string): void {
  strip = undefined;
  const callout = element("div", "callout callout-danger");
  callout.setAttribute("role", "alert");
  callout.append(
    element("p", "callout-title", "Can't read decision parameters"),
    element("p", "callout-body", message),
    button("Edit Decision Parameters", "button-secondary", () => vscode.postMessage({ type: "editParameters" }))
  );
  root.replaceChildren(callout);
}

function buildStrip(state: FilterState, key: string): StripView {
  const sliders = state.parameters.map((parameter) => buildSlider(parameter, state.scale));
  const count = element("p", "filter-count");
  count.setAttribute("role", "status");
  const reset = button("Reset", "button-text", () => {
    vscode.postMessage({ type: "reset" });
    sliders[0]?.inputs.min.focus(); // the button hides itself; keep keyboard users in the strip
  });
  const footer = element("div", "filter-footer");
  footer.append(count, reset);
  root.replaceChildren(...sliders.map((s) => s.block), footer);
  return { key, sliders, count, reset };
}

function buildSlider(parameter: FilterParameter, scale: GradeRange): SliderView {
  const block = element("section", "slider");
  const head = element("div", "slider-head");
  const value = element("span", "slider-value");
  const track = element("div", "slider-track");
  const inputs = { min: handle(parameter, "min", scale), max: handle(parameter, "max", scale) };
  const slider: SliderView = { block, parameter, inputs, value, track, together: undefined, lastSent: { ...scale } };
  for (const which of ["min", "max"] as const) {
    const input = inputs[which];
    const noteStart = () => (slider.together = input.value === inputs[other(which)].value ? Number(input.value) : undefined);
    input.addEventListener("pointerdown", noteStart);
    input.addEventListener("keydown", noteStart);
    input.addEventListener("input", () => onMove(slider, which, scale));
    // A handoff can leave the moved input where it started, so `change` alone may never fire.
    for (const end of ["change", "pointerup", "lostpointercapture"]) input.addEventListener(end, () => finishMove(slider));
  }
  head.append(element("span", "slider-name", parameter.name), value);
  track.append(element("div", "slider-fill"), inputs.min, inputs.max);
  block.append(head, track, marks(scale), ends(parameter));
  return slider;
}

/**
 * Handles may meet but never cross. When they start together, the moved one hands over:
 * dragging the top handle below the other moves the low end instead, so a range like "3"
 * can widen either way.
 */
function onMove(slider: SliderView, moved: Handle, scale: GradeRange): void {
  const { inputs, together } = slider;
  const attempted = Number(inputs[moved].value);
  const passesOther = moved === "max" ? attempted < Number(inputs.min.value) : attempted > Number(inputs.max.value);
  if (together !== undefined && (moved === "max" ? attempted <= together : attempted >= together)) {
    inputs[other(moved)].value = String(attempted);
    inputs[moved].value = String(together);
    if (document.activeElement === inputs[moved] && !inputs[moved].matches(":active")) inputs[other(moved)].focus();
  } else if (passesOther) {
    inputs[moved].value = inputs[other(moved)].value;
  }
  paint(slider, scale);
  if (!isDragging(slider)) finishMove(slider); // a key press is a whole move
}

/** Reports the range if it changed since the extension last heard of it. */
function finishMove(slider: SliderView): void {
  slider.together = undefined;
  const range = currentRange(slider);
  if (range.min === slider.lastSent.min && range.max === slider.lastSent.max) return;
  slider.lastSent = range;
  vscode.postMessage({ type: "setRange", id: slider.parameter.id, range });
}

function isDragging(slider: SliderView): boolean {
  return slider.inputs.min.matches(":active") || slider.inputs.max.matches(":active");
}

function updateSlider(slider: SliderView, range: GradeRange, scale: GradeRange, isDisabled: boolean): void {
  slider.inputs.min.disabled = isDisabled;
  slider.inputs.max.disabled = isDisabled;
  if (isDragging(slider)) return; // never fight a drag in progress; its end reports the result
  slider.inputs.min.value = String(range.min);
  slider.inputs.max.value = String(range.max);
  slider.lastSent = { ...range };
  paint(slider, scale);
}

function paint(slider: SliderView, scale: GradeRange): void {
  const range = currentRange(slider);
  slider.value.textContent = range.min === range.max ? String(range.min) : `${range.min} – ${range.max}`;
  slider.track.style.setProperty("--from", fraction(range.min, scale));
  slider.track.style.setProperty("--to", fraction(range.max, scale));
  // At the top of the scale the low handle must sit above the high one, or it can't be grabbed.
  slider.inputs.min.classList.toggle("is-on-top", range.min === scale.max);
  for (const input of [slider.inputs.min, slider.inputs.max]) input.setAttribute("aria-valuetext", valueText(Number(input.value), slider.parameter, scale));
}

function currentRange(slider: SliderView): GradeRange {
  return { min: Number(slider.inputs.min.value), max: Number(slider.inputs.max.value) };
}

function handle(parameter: FilterParameter, which: Handle, scale: GradeRange): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "range";
  input.className = "slider-input";
  input.min = String(scale.min);
  input.max = String(scale.max);
  input.step = "1";
  input.value = String(scale[which]);
  input.setAttribute("aria-label", `${parameter.name}, ${which === "min" ? "lowest" : "highest"} grade`);
  return input;
}

function marks(scale: GradeRange): HTMLElement {
  const row = element("div", "slider-marks");
  row.setAttribute("aria-hidden", "true");
  for (let grade = scale.min; grade <= scale.max; grade++) row.append(element("span", "", String(grade)));
  return row;
}

function ends(parameter: FilterParameter): HTMLElement {
  const row = element("div", "slider-ends");
  row.setAttribute("aria-hidden", "true");
  for (const text of [parameter.low ?? "", parameter.high ?? ""]) {
    const end = element("span", "", text);
    end.title = text; // the full text when it is cut short
    row.append(end);
  }
  return row;
}

/** Screen readers hear what the ends mean, not just the number. */
function valueText(grade: number, parameter: FilterParameter, scale: GradeRange): string {
  const meaning = grade === scale.min ? parameter.low : grade === scale.max ? parameter.high : undefined;
  return meaning ? `${grade}, ${meaning}` : String(grade);
}

function fraction(grade: number, scale: GradeRange): string {
  return String((grade - scale.min) / (scale.max - scale.min));
}

function other(which: Handle): Handle {
  return which === "min" ? "max" : "min";
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = element("button", `button ${className}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
