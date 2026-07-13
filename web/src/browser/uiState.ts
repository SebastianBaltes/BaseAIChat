/**
 * uiState.ts – lets the agent see what the user sees.
 *
 * The host app marks the elements the agent is allowed to know about with
 * `data-*` attributes. Nothing else is exposed: the agent never gets the raw
 * DOM, only this curated, hierarchical view.
 *
 *   data-group-key   grouping container   → nests everything inside it
 *   data-button-key  clickable control
 *   data-input-key   text/number input    → its current value is included
 *   data-select-key  choice control       → current value plus the options
 *   data-info-key    read-only text
 *
 * ```html
 * <section data-group-key="filters">
 *   <div data-select-key="status" data-value="open">
 *     <input type="radio" value="open" /> <input type="radio" value="done" />
 *   </div>
 *   <button data-button-key="apply">Apply</button>
 * </section>
 * ```
 *
 * readUIState() turns that into:
 *
 * ```json
 * { "uiElements": [{ "group": "filters", "children": [
 *     { "select": "status", "value": "open", "options": ["open", "done"] },
 *     { "button": "apply" }] }] }
 * ```
 *
 * Feed the result to the model as app context and it can reason about the
 * screen – and then act on it with the helpers in uiActions.ts.
 */
import { roundValues } from "../core/roundValues";

const ELEMENT_KEYS = ["data-input-key", "data-button-key", "data-info-key", "data-select-key"] as const;
const GROUP_KEY = "data-group-key";

export interface UIStateOptions {
  /** Root to scan (default: document.body). Scope it to exclude the chat panel itself. */
  root?: ParentNode;
  /** Include on-screen positions – only useful if the agent reasons about layout. */
  withPositions?: boolean;
  /** Decimals for those positions (default 0). */
  precision?: number;
  /** Extra app-level facts merged into the result, e.g. `{ page: "board", user: "ada" }`. */
  context?: () => Record<string, unknown>;
}

export interface UINode {
  [key: string]: unknown;
  children?: UINode[];
}

/** Reads the annotated part of the DOM into a structure the model can reason about. */
export function readUIState(options: UIStateOptions = {}): Record<string, unknown> {
  const { root = document.body, withPositions = false, precision = 0, context } = options;

  const tree: UINode[] = [];

  // One query for all annotated elements: querySelectorAll returns them in
  // document order, so the model sees the screen in reading order rather than
  // grouped by attribute type.
  const selector = ELEMENT_KEYS.map((key) => `[${key}]`).join(",");
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (!isVisible(element)) continue;

    const key = ELEMENT_KEYS.find((candidate) => element.hasAttribute(candidate));
    if (!key) continue;

    // Walk the element's groups from the outside in, creating each level once,
    // so two buttons in the same group end up as siblings rather than as two
    // copies of the group.
    let level = tree;
    for (const group of enclosingGroups(element, root)) {
      const name = group.getAttribute(GROUP_KEY)!;
      let node = level.find((candidate) => candidate.group === name);
      if (!node) {
        node = { group: name, children: [] };
        if (withPositions) node.at = centreOf(group);
        level.push(node);
      }
      level = node.children!;
    }

    const node = describe(element, key, withPositions);
    if (!level.some((existing) => existing[node.kind] === node.name)) {
      level.push(node.value);
    }
  }

  const result = { ...(context?.() ?? {}), uiElements: tree };
  return withPositions ? roundValues(result, precision) : result;
}

function describe(element: HTMLElement, key: (typeof ELEMENT_KEYS)[number], withPositions: boolean) {
  const kind = key.replace(/^data-|-key$/g, ""); // data-button-key → button
  const name = element.getAttribute(key)!;
  const node: UINode = { [kind]: name };

  if (kind === "select") {
    node.value = element.getAttribute("data-value") ?? inputValue(element);
    const options = Array.from(element.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .map((radio) => radio.value || radio.id)
      .filter(Boolean);
    const listed = Array.from(element.querySelectorAll<HTMLOptionElement>("option")).map((o) => o.value);
    const all = [...options, ...listed];
    if (all.length > 0) node.options = all;
  } else if (kind === "input") {
    node.value = inputValue(element);
  } else if (kind === "info") {
    node.text = element.textContent?.trim().slice(0, 200) ?? "";
  }

  if (withPositions) node.at = centreOf(element);
  return { kind, name, value: node };
}

function inputValue(element: HTMLElement): string | undefined {
  const field =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element
      : element.querySelector<HTMLInputElement>("input, textarea, select");
  return field?.value;
}

/** The `data-group-key` ancestors of an element, outermost first. */
function enclosingGroups(element: HTMLElement, root: ParentNode): HTMLElement[] {
  const groups: HTMLElement[] = [];
  let parent = element.parentElement;
  while (parent && parent !== root) {
    if (parent.hasAttribute(GROUP_KEY)) groups.unshift(parent);
    parent = parent.parentElement;
  }
  return groups;
}

/**
 * An element counts as visible only if it and all its ancestors are. An agent
 * that "clicks" something behind a closed accordion is worse than one that
 * says it cannot find it.
 */
function isVisible(element: HTMLElement | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
  }
  return true;
}

function centreOf(element: HTMLElement) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x: x + width / 2, y: y + height / 2 };
}
