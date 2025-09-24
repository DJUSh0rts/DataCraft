import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/DataCraft/", // <-- repo name. If using <user>.github.io root, use "/"
  plugins: [react()],
});
