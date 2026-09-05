/** Tiny DOM helpers. Not a framework; just less repetition. */

type Attrs = Record<string, string | boolean | number | ((e: Event) => void) | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function section(title: string, ...children: Array<Node | string | null | undefined>): HTMLElement {
  return el("section", { class: "panel" }, el("h2", {}, title), el("div", { class: "panel-body" }, ...children));
}
