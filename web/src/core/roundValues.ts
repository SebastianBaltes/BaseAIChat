/**
 * Rounds every number in a value tree. Handy as `transformResult` on the
 * evaluator: raw floats like 12.300000000000001 cost tokens and invite the
 * model to echo noise back at the user.
 *
 * @example
 * createEvaluator({ api, transformResult: (result) => roundValues(result, 2) })
 */
export function roundValues<T>(value: T, decimals: number): T {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** decimals;
    return (Math.round(value * factor) / factor) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => roundValues(item, decimals)) as T;
  }

  // Plain objects only. Dates, class instances and DOM nodes are passed through
  // untouched – rebuilding them field by field would strip their behaviour.
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = roundValues(item, decimals);
    }
    return result as T;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
