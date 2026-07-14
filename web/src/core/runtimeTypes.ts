/**
 * runtimeTypes.ts – expands the API description with live data before it is
 * shown to the model.
 *
 * The model is told about the host API by handing it a TypeScript source file
 * (imported with Vite's `?raw`). Static types alone force the model to guess at
 * valid values, and it guesses wrong: it will invent a status called "done"
 * when your board only knows "completed".
 *
 * So annotate the type with an expression that yields the values that exist
 * *right now*:
 *
 *   // @values context.statuses
 *   type TaskStatus = string;
 *
 * At query time this becomes:
 *
 *   type TaskStatus =
 *     | "todo"
 *     | "in-progress"
 *     | "completed";
 *
 * Call expandRuntimeTypes() each time you build the prompt, and the model sees
 * the current state of the app – no hard-coded lists to keep in sync.
 */

/** `// @values <expr>` above `type Foo = string;` */
const TYPE_ALIAS = /\/\/ @values (.+)\r?\n(\s*)type (\S+) = string;/g;

/** `// @values <expr>` above `foo: string;` inside an interface */
const INTERFACE_PROPERTY = /\/\/ @values (.+)\r?\n(\s*)(\S+): string;/g;

/**
 * Any annotation the passes above did not consume – never show it to the model.
 *
 * Deliberately matches the misplaced forms as well (inside a JSDoc block, or as a
 * block comment), because those are exactly the ones that silently did nothing.
 */
const LEFTOVER = /[ \t]*(?:\/\/|\/\*|\*)[ \t]*@values .*\r?\n?/g;

/** Optional markers that trim the source down to the part the model should see. */
const SECTION_START = "// @api-start";
const SECTION_END = "// @api-end";

/**
 * Expands every `@values` annotation in `source` and returns the result.
 *
 * @param source  Raw TypeScript text, e.g. `import api from "./api.ts?raw"`.
 * @param context Available as `context` inside the annotation expressions, so
 *                they can read live app state without touching globals.
 */
export function expandRuntimeTypes(source: string, context: Record<string, unknown> = {}): string {
  let result = source.replace(
    TYPE_ALIAS,
    (_match, expression: string, indent: string, name: string) =>
      `${indent}type ${name} =${buildUnion(evaluate(expression, context), indent)};`
  );

  result = result.replace(
    INTERFACE_PROPERTY,
    (_match, expression: string, indent: string, name: string) =>
      `${indent}${name}:${buildUnion(evaluate(expression, context), indent)};`
  );

  warnAboutLeftovers(result);
  result = result.replace(LEFTOVER, "");

  const start = result.indexOf(SECTION_START);
  const end = result.indexOf(SECTION_END);
  if (start !== -1 && end !== -1 && end > start) {
    result = result.slice(start + SECTION_START.length, end);
  }

  return result.trim();
}

/**
 * An annotation that no pass consumed did nothing – and a silent no-op is
 * indistinguishable from a working one. So say it out loud.
 *
 * This is not hypothetical: the FieldDraft integration wrote its annotations
 * into a JSDoc block, no pass matched, and for months the model was handed the
 * literal word "@values" instead of the live values – while the host believed
 * the mechanism was working. Costing a warning is cheaper than costing that.
 */
function warnAboutLeftovers(source: string): void {
  for (const [annotation] of source.matchAll(LEFTOVER)) {
    console.warn(
      `[baseaichat] @values annotation had no effect: ${annotation.trim()}\n` +
        "  It must be a line comment (// @values <expr>) directly above " +
        "`type Foo = string;` or `foo: string;`. Inside a JSDoc block, or anywhere " +
        "else, it is ignored – and the model sees the bare `string` type."
    );
  }
}

/**
 * Runs one annotation expression. Failures are never fatal: a broken or
 * not-yet-loaded expression degrades to the bare `string` type, which still
 * lets the model work – it just has to ask instead of knowing.
 */
function evaluate(expression: string, context: Record<string, unknown>): string[] {
  let value: unknown;
  try {
    value = new Function("context", `return (${expression});`)(context);
  } catch (error) {
    console.warn(`[baseaichat] @values expression failed: ${expression}`, error);
    return [];
  }

  if (!Array.isArray(value)) {
    console.warn(
      `[baseaichat] @values expression did not return an array: ${expression} → ${typeof value}`
    );
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function buildUnion(values: string[], indent: string): string {
  if (values.length === 0) return " string";
  const memberIndent = `${indent}  `;
  return values.map((value) => `\n${memberIndent}| ${JSON.stringify(value)}`).join("");
}
