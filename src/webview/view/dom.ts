/** Element helpers: text goes in with textContent only, never as HTML. */

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, variant: "primary" | "secondary" | "text", onClick: () => void): HTMLButtonElement {
  const b = element("button", `button button-${variant}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
