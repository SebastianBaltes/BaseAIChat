/**
 * webmcp.ts – hands the evaluator to agents *outside* the page.
 *
 * WebMCP lets a page register tools that a foreign agent (Chrome's built-in one,
 * an extension) can call. Our evaluator happens to fit its contract exactly: a
 * tool takes an input object and returns a string, and `Evaluator` already is
 * `(input: { code }) => Promise<string>`. So the whole export is one call.
 *
 * Status, because it matters for what you build on: WebMCP is **not a W3C
 * standard**. It is a Community Group draft (Google + Microsoft, February 2026)
 * and it still moves – `provideContext()` was dropped in March, and
 * `navigator.modelContext` was deprecated for `document.modelContext` in Chrome
 * 150. Chrome 149–156 run a public origin trial; without a trial token or the
 * `chrome://flags/#enable-webmcp-testing` flag the API is simply absent, and no
 * other browser ships it. That is why this lives in its own module, is opt-in,
 * and returns `false` rather than throwing: nothing else in the library depends
 * on it, and a host that calls it on a browser without WebMCP just carries on.
 *
 * ## Read this before you register it
 *
 * This gives a foreign agent the same arbitrary-JavaScript tool your own model
 * has. The guard still keeps that code from escaping the API – but it was never
 * meant to keep it from *using* the API, and the caller is no longer a model you
 * prompted. Page content turns into an injection vector: whatever an attacker can
 * get a foreign agent to read, that agent can ask this tool to run, with the full
 * reach of your API object.
 *
 * So the same rule as always, only sharper: **the API object is the security
 * boundary.** Register this only if you would hand that API to a stranger. If it
 * can delete, pay, or send, put `confirm` in front of it.
 */
import type { Evaluator } from "../core/evaluator";

export interface EvaluateToolOptions {
  /** The evaluator to expose – whatever `createEvaluator()` returned. */
  evaluate: Evaluator;

  /**
   * What the tool does and what it may call – the same string you already pass
   * as `toolDescription`, i.e. your expanded API description. A foreign agent
   * has no system prompt from you, so this text is *all* it knows.
   */
  description: string;

  /** Tool name as the agent sees it. Default `"evaluate"`. */
  name?: string;

  /**
   * Called before the code runs. Return `false` to refuse. Use it to put a user
   * gesture in front of a foreign agent – your own chat can run unconfirmed
   * while this one has to ask.
   */
  confirm?: (code: string) => boolean | Promise<boolean>;

  /** Abort it to unregister the tool again. */
  signal?: AbortSignal;
}

/** The slice of the WebMCP draft we use. Not in lib.dom yet. */
interface ModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      execute: (input: Record<string, unknown>) => Promise<string> | string;
    },
    options?: { signal?: AbortSignal }
  ): Promise<void>;
}

/**
 * `document.modelContext` since Chrome 150; `navigator.modelContext` before that
 * and deprecated since. Try both, so a page works across the origin-trial window.
 */
function modelContext(): ModelContext | undefined {
  const onDocument = (globalThis.document as unknown as { modelContext?: ModelContext } | undefined)
    ?.modelContext;
  if (onDocument) return onDocument;

  return (globalThis.navigator as unknown as { modelContext?: ModelContext } | undefined)
    ?.modelContext;
}

/**
 * Registers the evaluator as a WebMCP tool.
 *
 * @returns `true` if it was registered, `false` if this browser has no WebMCP –
 *          which is the common case, so branch on it instead of assuming.
 */
export async function registerEvaluateTool(options: EvaluateToolOptions): Promise<boolean> {
  const { evaluate, description, name = "evaluate", confirm, signal } = options;

  const context = modelContext();
  if (!context) return false;

  await context.registerTool(
    {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "JavaScript to run against the API. Use `return` to hand a value back. " +
              "Only the documented API functions and standard built-ins are available.",
          },
        },
        required: ["code"],
      },
      // Errors come back as text rather than as a rejection, the same way the
      // in-page agent sees them: an agent that can read what went wrong fixes
      // its own code, and one that gets an exception usually just gives up.
      execute: async (input) => {
        const code = typeof input?.code === "string" ? input.code : "";

        if (confirm && !(await confirm(code))) {
          return "Error: the user declined to run this code.";
        }

        try {
          return await evaluate({ code });
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    signal ? { signal } : undefined
  );

  return true;
}
