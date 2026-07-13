/**
 * uiActions.ts – lets the agent operate the app the same way the user does.
 *
 * These helpers go into the evaluator's API object, so generated code can call
 * them. They address elements by the same `data-*` keys that readUIState()
 * reports, which means the agent can only touch what the app deliberately
 * exposed – never an arbitrary selector.
 *
 * Driving the real controls (rather than writing into the store behind them)
 * keeps the app's own validation, side effects and undo history intact: the
 * agent's changes are indistinguishable from the user's.
 */

export interface UIActionOptions {
  /** Root to search (default: document). */
  root?: ParentNode;
  /** Class added to an element while it is highlighted (default "ai-highlight"). */
  highlightClass?: string;
  /** How long the highlight stays (default 4000ms). */
  highlightMs?: number;
  /** Max actions per window (default 60) – a runaway agent should not click 10,000 times. */
  maxActionsPerWindow?: number;
  /** Rate-limit window in ms (default 60000). */
  rateWindowMs?: number;
  /** Called after any action changed the UI, e.g. to re-read state. */
  onAction?: (action: string, key: string) => void;
}

export interface UIActions {
  /** Scroll an element into view and flash it, so the user sees what the agent means. */
  highlightElement(key: string): void;
  /** Click the button with this `data-button-key`. */
  clickElement(key: string): void;
  /** Choose an option inside the `data-select-key` control. */
  selectOption(key: string, option: string): void;
  /** Type a value into the `data-input-key` field. */
  fillInput(key: string, value: string | number): void;
}

/**
 * Builds the action helpers.
 *
 * @example
 * const ui = createUIActions();
 * const evaluate = createEvaluator({ api: { ...appApi, ...ui, readUIState } });
 */
export function createUIActions(options: UIActionOptions = {}): UIActions {
  const {
    root = document,
    highlightClass = "ai-highlight",
    highlightMs = 4000,
    maxActionsPerWindow = 60,
    rateWindowMs = 60_000,
    onAction,
  } = options;

  let actions = 0;
  let windowStart = Date.now();

  function rateLimit(action: string) {
    const now = Date.now();
    if (now - windowStart > rateWindowMs) {
      actions = 0;
      windowStart = now;
    }
    if (++actions > maxActionsPerWindow) {
      throw new Error(
        `Too many UI actions (${maxActionsPerWindow} per ${rateWindowMs / 1000}s). ` +
          `Stop and explain to the user what is happening.`
      );
    }
    onAction?.(action, "");
  }

  /**
   * Keys come from the model, so they never reach the CSS parser. Selecting on
   * the bare attribute and comparing the value in JavaScript means a crafted
   * key like `x"], [data-button-key="delete-all` simply matches nothing –
   * there is no selector to break out of, and no escaping to get wrong.
   */
  function find(attribute: string, key: string): HTMLElement | null {
    if (typeof key !== "string" || key.length > 200) return null;
    const candidates = root.querySelectorAll<HTMLElement>(`[${attribute}]`);
    for (const candidate of Array.from(candidates)) {
      if (candidate.getAttribute(attribute) === key) return candidate;
    }
    return null;
  }

  function require(attribute: string, key: string, what: string): HTMLElement {
    const element = find(attribute, key);
    if (!element) {
      throw new Error(
        `No ${what} named "${key}". Call readUIState() to see which keys exist on screen right now.`
      );
    }
    return element;
  }

  function highlightElement(key: string): void {
    const element =
      find("data-button-key", key) ??
      find("data-input-key", key) ??
      find("data-select-key", key) ??
      find("data-info-key", key) ??
      find("data-group-key", key);
    if (!element) return; // highlighting is cosmetic – never fail a task over it

    element.classList.add(highlightClass);
    element.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => element.classList.remove(highlightClass), highlightMs);
  }

  function clickElement(key: string): void {
    rateLimit("click");
    const element = require("data-button-key", key, "button");
    highlightElement(key);
    element.click();
  }

  function selectOption(key: string, option: string): void {
    rateLimit("select");
    const container = require("data-select-key", key, "select control");
    highlightElement(key);

    const radio = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    ).find((candidate) => candidate.value === option || candidate.id === option);
    if (radio) {
      radio.click();
      return;
    }

    const select = container instanceof HTMLSelectElement ? container : container.querySelector("select");
    if (select && Array.from(select.options).some((o) => o.value === option)) {
      setNativeValue(select, option);
      return;
    }

    throw new Error(
      `"${option}" is not an option of "${key}". Call readUIState() – the control lists its options[].`
    );
  }

  function fillInput(key: string, value: string | number): void {
    rateLimit("fill");
    const container = require("data-input-key", key, "input");
    highlightElement(key);

    const field =
      container instanceof HTMLInputElement || container instanceof HTMLTextAreaElement
        ? container
        : container.querySelector<HTMLInputElement>("input, textarea");
    if (!field) throw new Error(`"${key}" has no input element inside it.`);

    setNativeValue(field, String(value));
  }

  return { highlightElement, clickElement, selectOption, fillInput };
}

/**
 * Sets a form value the way a user would.
 *
 * React installs its own `value` setter on the element instance and tracks the
 * last value it wrote. Assigning `element.value` directly updates the DOM but
 * leaves React's tracker in sync with the *old* value, so the change event is
 * swallowed and the component never re-renders. Writing through the prototype's
 * setter bypasses the tracker, and the dispatched events then look native.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
