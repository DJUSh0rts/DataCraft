// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/DataCraft/",        // your repo name
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  optimizeDeps: {
    include: ["monaco-editor", "@monaco-editor/react"],
  },
});
