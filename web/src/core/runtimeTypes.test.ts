import { describe, expect, it, vi } from "vitest";
import { expandRuntimeTypes } from "./runtimeTypes";

describe("expandRuntimeTypes", () => {
  // A misplaced annotation used to be a silent no-op: no pass matched it, and the
  // model was handed the literal word "@values" while the host believed it was
  // handing over live values. That is how FieldDraft shipped a dead annotation for
  // months. A no-op that looks like a success has to be loud.
  describe("an annotation that does nothing says so", () => {
    it("warns when @values sits in a JSDoc block instead of a line comment", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const source = ["/**", " * @values context.featureTypes", " */", "type Feature = string;"].join("\n");

      const result = expandRuntimeTypes(source, { featureTypes: ["box", "hole"] });

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("had no effect");
      // The annotation did not expand – but it must not reach the model either.
      expect(result).not.toContain("@values");
      expect(result).toContain("type Feature = string;");
      warn.mockRestore();
    });

    it("stays quiet when every annotation was consumed", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expandRuntimeTypes("// @values context.statuses\ntype Status = string;", {
        statuses: ["todo"],
      });

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

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
