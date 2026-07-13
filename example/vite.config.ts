import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The library is consumed as source. In a real app you would install it
      // instead – the import path stays the same either way.
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
