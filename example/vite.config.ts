import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The library is consumed as source, not as a built bundle.
      //
      // This example gets away with a bare alias because it sits next to web/,
      // so the library's own imports (react, ai, acorn, …) resolve upward into
      // web/node_modules. An app that pulls the library in from somewhere else
      // – a submodule under third_party/, say – needs to map those specifiers
      // explicitly. See "Die Lib wird als Quelltext eingebunden" in the README.
      baseaichat: resolvePath("../web/src/index.ts"),
    },
    // One React instance only: two copies break hooks.
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5180,
    proxy: {
      // The chat calls /aichat on its own origin, so the browser never learns
      // where the key-holding proxy actually lives – and there is no CORS.
      "/aichat": {
        target: process.env.AI_PROXY_URL ?? "http://localhost:8090",
        changeOrigin: true,
      },
    },
  },
});
