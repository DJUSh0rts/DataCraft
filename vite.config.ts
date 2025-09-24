import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// If deploying to https://<user>.github.io/<repo>/, base must be "/<repo>/"
export default defineConfig({
  base: "/DataCraft/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true
  },
  server: {
    port: 5173,
    host: true
  }
});
