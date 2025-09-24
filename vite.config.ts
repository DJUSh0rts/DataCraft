// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import monacoEditorPlugin from "vite-plugin-monaco-editor";

export default defineConfig({
  base: "/DataCraft/",               // must end with /
  plugins: [
    react(),
    monacoEditorPlugin({
      // keep it lean; add more workers if you use them
      languageWorkers: ["editorWorkerService", "typescript", "json"],
      publicPath: "monaco",          // emitted under /DataCraft/monaco/*
    }),
  ],
  build: {
    sourcemap: true,                 // makes it easier to see errors in Pages
  },
});
