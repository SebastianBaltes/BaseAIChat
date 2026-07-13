import { describe, expect, it } from "vitest";
import { expandRuntimeTypes } from "./runtimeTypes";

describe("expandRuntimeTypes", () => {
  it("expands a type alias into the values that exist right now", () => {
    const source = [
      "// @values context.statuses",
      "type TaskStatus = string;",
    ].join("\n");

    const result = expandRuntimeTypes(source, { statuses: ["todo", "completed"] });

    expect(result).toBe(['type TaskStatus =', '  | "todo"', '  | "completed";'].join("\n"));
    expect(result).not.toContain("@values");
  });

  it("expands an interface property and keeps its indentation", () => {
    const source = [
      "interface Task {",
      "  // @values context.owners",
      "  owner: string;",
      "}",
    ].join("\n");

    const result = expandRuntimeTypes(source, { owners: ["ada"] });

    expect(result).toContain('  owner:\n    | "ada";');
  });

  it("falls back to `string` when the expression yields nothing", () => {
    const source = "// @values context.missing\ntype Label = string;";
    expect(expandRuntimeTypes(source, {})).toBe("type Label = string;");
  });

  it("survives a broken expression rather than breaking the prompt", () => {
    const source = "// @values context.nope.deeper\ntype Label = string;";
    expect(expandRuntimeTypes(source, {})).toBe("type Label = string;");
  });

  it("keeps only the section the model should see", () => {
    const source = [
      'import { Task } from "./types";',
      "// @api-start",
      "declare function listTasks(): Task[];",
      "// @api-end",
      "export {};",
    ].join("\n");

    expect(expandRuntimeTypes(source)).toBe("declare function listTasks(): Task[];");
  });

  it("escapes values that would otherwise break the generated type", () => {
    const source = "// @values context.labels\ntype Label = string;";
    const result = expandRuntimeTypes(source, { labels: ['say "hi"'] });
    expect(result).toContain('| "say \\"hi\\""');
  });
});
