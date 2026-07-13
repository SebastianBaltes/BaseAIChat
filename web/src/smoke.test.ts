/**
 * smoke.test.ts – the one test that talks to a real model.
 *
 * It exercises the whole chain that unit tests cannot: library transport → Go
 * proxy (which injects the key) → provider → tool call → guard → execution
 * against a live store → result → answer.
 *
 * Skipped unless SMOKE=1, because it costs money and needs the proxy running:
 *
 *   cd server && AI_PROVIDER=openrouter AI_API_KEY=… AI_PROXY_ADDR=:8090 go run ./cmd/aichat-proxy
 *   cd web    && SMOKE=1 npx vitest run src/smoke.test.ts
 */
import { describe, expect, it } from "vitest";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { createModel } from "./providers/createModel";
import { createEvaluator } from "./core/evaluator";
import { expandRuntimeTypes } from "./core/runtimeTypes";

const PROXY = process.env.SMOKE_PROXY ?? "http://localhost:8090/aichat";
const MODEL = process.env.SMOKE_MODEL ?? "google/gemini-3-flash-preview";

/**
 * The API as the model sees it – with the `@values` annotations still in place.
 * Expanding them is part of what this test proves: without the concrete union,
 * the model guesses that "unassigned" means an empty field and its filter
 * silently matches nothing.
 */
const API_SOURCE = `
// @values context.statuses
type Status = string;

// @values context.assignees
type Assignee = string;

interface Task {
  id: number;
  title: string;
  status: Status;
  assignee: Assignee;
  estimate: number;
}

/** Copies – assigning to them changes nothing. Every change goes through updateTask(). */
declare function listTasks(): Task[];

declare function updateTask(
  id: number,
  patch: { status?: Status; assignee?: Assignee; estimate?: number }
): Task;
`;

describe.skipIf(!process.env.SMOKE)("end-to-end against a real provider", () => {
  it("reads the board, changes it through guarded code, and answers", async () => {
    const tasks = [
      { id: 1, title: "Design onboarding", status: "done", assignee: "ada", estimate: 2 },
      { id: 2, title: "Rate-limit the API", status: "in-progress", assignee: "linus", estimate: 3 },
      { id: 3, title: "Fix flaky test", status: "todo", assignee: "unassigned", estimate: 1 },
      { id: 4, title: "Release notes", status: "todo", assignee: "unassigned", estimate: 0.5 },
    ];

    const codeRun: string[] = [];
    const evaluate = createEvaluator({
      api: {
        listTasks: () => tasks.map((task) => ({ ...task })),
        updateTask: (id: number, patch: Record<string, unknown>) => {
          const task = tasks.find((candidate) => candidate.id === id);
          if (!task) throw new Error(`No task with id ${id}.`);
          Object.assign(task, patch);
          return { ...task };
        },
      },
      onBeforeRun: (code) => codeRun.push(code),
    });

    // The same transport the browser uses: everything is POSTed to the proxy,
    // and the upstream path travels in a header.
    const proxyFetch: typeof fetch = async (input, init) => {
      const base = new URL(PROXY);
      const requested = new URL(String(input), base.origin);
      const targetPath = requested.pathname.slice(base.pathname.length);
      return fetch(base.origin + base.pathname + requested.search, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), "X-Target-Path": targetPath },
      });
    };

    const result = streamText({
      model: createModel({ provider: "openrouter", model: MODEL, baseURL: PROXY, fetch: proxyFetch }),
      stopWhen: stepCountIs(6),
      system:
        "You are the assistant in a sprint board. Use the evaluate tool to read and change " +
        "the board. Act without asking. Answer in one short sentence.",
      messages: [
        {
          role: "user",
          content: "Assign every unassigned todo to grace, then tell me how many days of work are still open.",
        },
      ],
      tools: {
        evaluate: tool({
          description:
            "Runs JavaScript against the board and returns whatever you `return`.\n\n```ts\n" +
            expandRuntimeTypes(API_SOURCE, {
              statuses: ["todo", "in-progress", "review", "done"],
              assignees: ["ada", "grace", "linus", "unassigned"],
            }) +
            "\n```",
          inputSchema: jsonSchema<{ code: string }>({
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          }),
          execute: async ({ code }) => {
            try {
              return await evaluate({ code });
            } catch (error) {
              return `Error: ${(error as Error).message}`;
            }
          },
        }),
      },
    });

    let answer = "";
    let toolCalls = 0;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") answer += part.text;
      if (part.type === "tool-call") toolCalls++;
      if (part.type === "error") throw new Error(`stream error: ${JSON.stringify(part.error)}`);
    }

    console.log("\ncode the model wrote:\n" + codeRun.join("\n---\n"));
    console.log("\nanswer:", answer.trim());

    expect(toolCalls, "the model never called the tool").toBeGreaterThan(0);
    expect(tasks.filter((task) => task.assignee === "grace")).toHaveLength(2);
    expect(answer.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
