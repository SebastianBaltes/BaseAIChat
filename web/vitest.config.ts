import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The guard and the evaluator are pure; the UI helpers need a DOM. jsdom for
    // everything keeps one config and costs a few milliseconds.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
