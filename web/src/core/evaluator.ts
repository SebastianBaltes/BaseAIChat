/**
 * evaluator.ts – runs model-generated JavaScript against the host app's API.
 *
 * This is the "evaluate" tool the model calls. Instead of exposing dozens of
 * narrow tool definitions, the app exposes one API object and lets the model
 * write code against it: fewer tokens, and the model can loop, filter and
 * combine in a single call instead of a dozen round trips.
 *
 * Layers, in the order a call passes through them:
 *   1. input check      – type and length
 *   2. rate limit       – per evaluator instance, not per page
 *   3. static guard     – guardCode(); the actual security boundary
 *   4. execution        – `with (api)` inside an async function, with a timeout
 *   5. output shaping   – transform, serialise, truncate
 */
import { guardCode, type GuardOptions } from "./guard";

export interface EvaluatorOptions {
  /**
   * The API object the model writes code against. Its keys become the names
   * available inside the generated code, and nothing else is reachable.
   */
  api: Record<string, unknown>;

  /** Runs before execution, e.g. to log the code the model wrote. */
  onBeforeRun?: (code: string) => void;
  /** Runs after a successful execution, e.g. to re-render or push an undo entry. */
  onAfterRun?: () => void;

  /**
   * Reshapes the result before it is serialised for the model – round numbers,
   * drop internal fields, trim large collections.
   */
  transformResult?: (result: unknown) => unknown;

  /** Max length of the generated code (default 10000). */
  maxCodeLength?: number;
  /** Max length of the serialised result handed back to the model (default 50000). */
  maxResultLength?: number;
  /** Timeout for one execution in ms (default 30000). Async hangs only – see guard.ts. */
  timeoutMs?: number;
  /** Max calls per rate-limit window (default 40). */
  maxCallsPerWindow?: number;
  /** Rate-limit window in ms (default 60000). */
  rateWindowMs?: number;
  /** Extra globals the generated code may reference beyond the safe built-ins. */
  extraGlobals?: string[];
}

export type Evaluator = (input: { code: string }) => Promise<string>;

/**
 * Builds the evaluate function. One evaluator owns its own rate-limit budget,
 * so two chats on one page cannot starve each other.
 *
 * @example
 * const evaluate = createEvaluator({
 *   api: { ...boardApi, ...uiActions },
 *   onAfterRun: () => board.notifyListeners(),
 * });
 * const result = await evaluate({ code: "return listTasks()" });
 */
export function createEvaluator(options: EvaluatorOptions): Evaluator {
  const {
    api,
    onBeforeRun,
    onAfterRun,
    transformResult,
    maxCodeLength = 10_000,
    maxResultLength = 50_000,
    timeoutMs = 30_000,
    maxCallsPerWindow = 40,
    rateWindowMs = 60_000,
    extraGlobals = [],
  } = options;

  const guardOptions: GuardOptions = {
    apiNames: Object.keys(api),
    extraGlobals,
    maxLength: maxCodeLength,
  };

  let callsInWindow = 0;
  let windowStart = Date.now();

  return async function evaluate({ code }): Promise<string> {
    onBeforeRun?.(code);

    if (typeof code !== "string") {
      throw new Error("The 'code' argument must be a string of JavaScript.");
    }

    const now = Date.now();
    if (now - windowStart > rateWindowMs) {
      callsInWindow = 0;
      windowStart = now;
    }
    if (++callsInWindow > maxCallsPerWindow) {
      throw new Error(
        `Rate limit reached (${maxCallsPerWindow} calls per ${rateWindowMs / 1000}s). ` +
          `Stop and tell the user what you have done so far.`
      );
    }

    const verdict = guardCode(code, guardOptions);
    if (!verdict.ok) {
      const where = verdict.at ? ` (line ${verdict.at.line}, column ${verdict.at.column})` : "";
      // Thrown, not returned: the caller turns it into a tool error, which the
      // model sees and can correct in the next step.
      throw new Error(`Rejected${where}: ${verdict.reason}`);
    }

    const result = await runWithTimeout(code, api, timeoutMs);
    const shaped = transformResult ? transformResult(result) : result;

    onAfterRun?.();

    return serialise(shaped, maxResultLength);
  };
}

/**
 * Executes the code with the API in scope.
 *
 * `AsyncFunction` is reached through `new Function` because the constructor is
 * not a global binding. This is the one place that construct is allowed – the
 * code it compiles has already passed the guard.
 */
async function runWithTimeout(code: string, api: Record<string, unknown>, timeoutMs: number) {
  const AsyncFunction = new Function("return (async function () {}).constructor")() as FunctionConstructor;
  const run = new AsyncFunction("__api__", `with (__api__) {\n${code}\n}`) as (
    api: Record<string, unknown>
  ) => Promise<unknown>;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout: execution exceeded ${timeoutMs / 1000}s.`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([run(api), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns a result into the string the model receives. Code with no `return`
 * yields undefined – report that as an explicit success so the model does not
 * read it as a failure.
 */
function serialise(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return '{"ok":true}';

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value, (_key, item) =>
        item && typeof item.toJSON === "function" ? item.toJSON() : item
      );
    } catch {
      // Cyclic structures, DOM nodes, class instances with getters that throw…
      text = String(value);
    }
    if (text === undefined) text = '{"ok":true}';
  }

  if (text.length > maxLength) {
    return (
      text.slice(0, maxLength) +
      `\n… [truncated: ${text.length} characters, limit ${maxLength}. ` +
      `Query a narrower slice of the data.]`
    );
  }
  return text;
}
