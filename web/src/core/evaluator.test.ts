import { describe, expect, it, vi } from "vitest";
import { createEvaluator } from "./evaluator";

const api = {
  listTasks: () => [
    { id: 1, title: "Write docs", done: false, estimate: 1.005 },
    { id: 2, title: "Ship it", done: true, estimate: 2 },
  ],
  addTask: vi.fn((title: string) => ({ id: 3, title })),
  slowCall: () => new Promise((resolve) => setTimeout(resolve, 50_000)),
};

describe("createEvaluator", () => {
  it("runs code against the API and returns a serialised result", async () => {
    const evaluate = createEvaluator({ api });
    const result = await evaluate({ code: "return listTasks().filter((t) => !t.done).length;" });
    expect(result).toBe("1");
  });

  it("awaits async API calls", async () => {
    const evaluate = createEvaluator({
      api: { fetchCount: async () => 7 },
    });
    expect(await evaluate({ code: "const n = await fetchCount(); return n * 2;" })).toBe("14");
  });

  it("reports success when the code returns nothing", async () => {
    const evaluate = createEvaluator({ api });
    expect(await evaluate({ code: `addTask("New");` })).toBe('{"ok":true}');
  });

  it("rejects unsafe code before executing a single statement", async () => {
    const addTask = vi.fn();
    const evaluate = createEvaluator({ api: { addTask } });
    await expect(
      evaluate({ code: `addTask("first"); return fetch("https://evil.example");` })
    ).rejects.toThrow(/Rejected/);
    expect(addTask, "no part of rejected code may run").not.toHaveBeenCalled();
  });

  it("applies transformResult before serialising", async () => {
    const evaluate = createEvaluator({
      api,
      transformResult: (result) => ({ wrapped: result }),
    });
    expect(await evaluate({ code: "return 41 + 1;" })).toBe('{"wrapped":42}');
  });

  it("runs the lifecycle hooks", async () => {
    const onBeforeRun = vi.fn();
    const onAfterRun = vi.fn();
    const evaluate = createEvaluator({ api, onBeforeRun, onAfterRun });

    await evaluate({ code: "return 1;" });
    expect(onBeforeRun).toHaveBeenCalledWith("return 1;");
    expect(onAfterRun).toHaveBeenCalledTimes(1);

    await expect(evaluate({ code: "return window;" })).rejects.toThrow();
    expect(onAfterRun, "a rejected run must not trigger side effects").toHaveBeenCalledTimes(1);
  });

  it("truncates oversized results instead of flooding the context window", async () => {
    const evaluate = createEvaluator({ api, maxResultLength: 40 });
    const result = await evaluate({ code: `return "x".repeat(500);` });
    expect(result.length).toBeLessThan(200);
    expect(result).toMatch(/truncated/);
  });

  it("enforces its own rate limit", async () => {
    const evaluate = createEvaluator({ api, maxCallsPerWindow: 2 });
    await evaluate({ code: "return 1;" });
    await evaluate({ code: "return 2;" });
    await expect(evaluate({ code: "return 3;" })).rejects.toThrow(/Rate limit/);
  });

  it("gives each evaluator its own rate-limit budget", async () => {
    const first = createEvaluator({ api, maxCallsPerWindow: 1 });
    const second = createEvaluator({ api, maxCallsPerWindow: 1 });
    await first.call(null, { code: "return 1;" });
    // One exhausted chat must not lock out another chat on the same page.
    await expect(second({ code: "return 1;" })).resolves.toBe("1");
  });

  it("times out a hanging async call", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = createEvaluator({ api, timeoutMs: 100 });
      const pending = evaluate({ code: "await slowCall(); return 1;" });
      const assertion = expect(pending).rejects.toThrow(/Timeout/);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a runtime error from the API to the caller", async () => {
    const evaluate = createEvaluator({
      api: {
        explode: () => {
          throw new Error("board is locked");
        },
      },
    });
    await expect(evaluate({ code: "return explode();" })).rejects.toThrow(/board is locked/);
  });
});
