import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // relative base so the site works at any GitHub Pages path
  base: "./",
  build: { chunkSizeWarningLimit: 1500 },
});
