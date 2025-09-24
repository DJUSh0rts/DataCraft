import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/DataCraft/",  // repo name
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
});
