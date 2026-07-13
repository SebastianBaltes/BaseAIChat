import { beforeEach, describe, expect, it, vi } from "vitest";
import { readUIState } from "./uiState";
import { createUIActions } from "./uiActions";

// jsdom has no layout engine, so scrolling is a no-op stub.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <section data-group-key="filters">
      <div data-select-key="status" data-value="open">
        <input type="radio" value="open" checked />
        <input type="radio" value="done" />
      </div>
      <div data-input-key="search"><input type="text" value="docs" /></div>
      <button data-button-key="apply">Apply</button>
    </section>
    <section data-group-key="board">
      <span data-info-key="count">2 tasks</span>
      <button data-button-key="clear">Clear</button>
      <div style="display: none">
        <button data-button-key="hidden-danger">Delete everything</button>
      </div>
    </section>
  `;
});

describe("readUIState", () => {
  it("reports the annotated elements grouped as they are nested", () => {
    const state = readUIState() as { uiElements: any[] };

    expect(state.uiElements).toEqual([
      {
        group: "filters",
        children: [
          { select: "status", value: "open", options: ["open", "done"] },
          { input: "search", value: "docs" },
          { button: "apply" },
        ],
      },
      {
        group: "board",
        children: [{ info: "count", text: "2 tasks" }, { button: "clear" }],
      },
    ]);
  });

  it("omits hidden elements, so the agent cannot act on what the user cannot see", () => {
    const serialised = JSON.stringify(readUIState());
    expect(serialised).not.toContain("hidden-danger");
  });

  it("merges app context into the state", () => {
    const state = readUIState({ context: () => ({ page: "board" }) });
    expect(state.page).toBe("board");
  });
});

describe("createUIActions", () => {
  it("clicks a button by its key", () => {
    const clicked = vi.fn();
    document.querySelector('[data-button-key="apply"]')!.addEventListener("click", clicked);

    createUIActions().clickElement("apply");

    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("fills an input so a framework-controlled field notices", () => {
    const input = document.querySelector<HTMLInputElement>('[data-input-key="search"] input')!;
    const changes: string[] = [];
    input.addEventListener("input", () => changes.push(input.value));

    createUIActions().fillInput("search", "release notes");

    expect(input.value).toBe("release notes");
    expect(changes, "an input event must fire, or React never re-renders").toEqual(["release notes"]);
  });

  it("selects a radio option", () => {
    createUIActions().selectOption("status", "done");
    const done = document.querySelector<HTMLInputElement>('input[value="done"]')!;
    expect(done.checked).toBe(true);
  });

  it("tells the agent how to recover when a key does not exist", () => {
    const ui = createUIActions();
    expect(() => ui.clickElement("nope")).toThrow(/readUIState/);
    expect(() => ui.selectOption("status", "archived")).toThrow(/options/);
  });

  it("rate-limits a runaway agent", () => {
    const ui = createUIActions({ maxActionsPerWindow: 2 });
    ui.clickElement("apply");
    ui.clickElement("apply");
    expect(() => ui.clickElement("apply")).toThrow(/Too many UI actions/);
  });

  it("does not let a crafted key break out of the selector", () => {
    const ui = createUIActions();
    expect(() => ui.clickElement('apply"], [data-button-key="clear')).toThrow(/No button named/);
  });
});
