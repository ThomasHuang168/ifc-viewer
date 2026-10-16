import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works at https://<user>.github.io/<any-repo-name>/
  base: "./",
  optimizeDeps: {
    // Pre-bundling web-ifc breaks its WASM loading
    exclude: ["web-ifc"],
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
  },
});
