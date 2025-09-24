import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import monacoEditorPlugin from "vite-plugin-monaco-editor";

export default defineConfig({
  base: "/DataCraft/",
  plugins: [
    react(),
    monacoEditorPlugin({
      languageWorkers: ["editorWorkerService", "typescript", "json"],
      publicPath: "monaco",
    }),
  ],
  build: { sourcemap: true },
});
