import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEvaluateTool } from "./webmcp";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: Record<string, unknown>) => Promise<string> | string;
};

/** Stands in for `document.modelContext`, which no test browser has. */
function fakeModelContext() {
  const tools: RegisteredTool[] = [];
  const options: Array<{ signal?: AbortSignal } | undefined> = [];

  const context = {
    registerTool: vi.fn(async (tool: RegisteredTool, opts?: { signal?: AbortSignal }) => {
      tools.push(tool);
      options.push(opts);
    }),
  };

  Object.defineProperty(document, "modelContext", { value: context, configurable: true });
  return { tools, options };
}

afterEach(() => {
  Reflect.deleteProperty(document, "modelContext");
  Reflect.deleteProperty(navigator, "modelContext");
});

describe("registerEvaluateTool", () => {
  it("says so instead of throwing when the browser has no WebMCP", async () => {
    // The common case by far: WebMCP ships behind an origin trial in Chrome and
    // nowhere else at all. A host must be able to branch on this.
    expect(await registerEvaluateTool({ evaluate: async () => "", description: "…" })).toBe(false);
  });

  it("registers the evaluator under the WebMCP tool contract", async () => {
    const { tools } = fakeModelContext();

    const registered = await registerEvaluateTool({
      evaluate: async ({ code }) => `ran: ${code}`,
      description: "## API\n\ninterface AgentApi { listTasks(): Task[] }",
    });

    expect(registered).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("evaluate");
    // A foreign agent has no system prompt from us – the description is all it knows.
    expect(tools[0].description).toContain("interface AgentApi");
    expect(tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    });
  });

  it("runs the code through the evaluator and returns its string", async () => {
    const { tools } = fakeModelContext();
    const evaluate = vi.fn(async ({ code }: { code: string }) => `result of ${code}`);

    await registerEvaluateTool({ evaluate, description: "…" });
    const output = await tools[0].execute({ code: "return listTasks()" });

    expect(evaluate).toHaveBeenCalledWith({ code: "return listTasks()" });
    expect(output).toBe("result of return listTasks()");
  });

  it("hands a rejected guard back as text, not as an exception", async () => {
    // Same contract the in-page agent gets: an agent that can read the error
    // rewrites its code, one that gets an exception gives up.
    const { tools } = fakeModelContext();

    await registerEvaluateTool({
      evaluate: async () => {
        throw new Error("`fetch` is not available.");
      },
      description: "…",
    });

    await expect(tools[0].execute({ code: "fetch('/x')" })).resolves.toBe(
      "Error: `fetch` is not available."
    );
  });

  it("lets the host put a confirmation in front of a foreign agent", async () => {
    const { tools } = fakeModelContext();
    const evaluate = vi.fn(async () => "done");

    await registerEvaluateTool({
      evaluate,
      description: "…",
      confirm: (code) => !code.includes("removeTask"),
    });

    await expect(tools[0].execute({ code: "removeTask(1)" })).resolves.toContain("declined");
    expect(evaluate).not.toHaveBeenCalled();

    await expect(tools[0].execute({ code: "listTasks()" })).resolves.toBe("done");
  });

  it("passes the abort signal through, so the tool can be unregistered", async () => {
    const { options } = fakeModelContext();
    const controller = new AbortController();

    await registerEvaluateTool({
      evaluate: async () => "",
      description: "…",
      signal: controller.signal,
    });

    expect(options[0]?.signal).toBe(controller.signal);
  });

  it("still finds the pre-Chrome-150 navigator.modelContext", async () => {
    const context = { registerTool: vi.fn(async () => {}) };
    Object.defineProperty(navigator, "modelContext", { value: context, configurable: true });

    expect(await registerEvaluateTool({ evaluate: async () => "", description: "…" })).toBe(true);
    expect(context.registerTool).toHaveBeenCalledOnce();
  });
});
