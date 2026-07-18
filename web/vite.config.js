import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // relative base so the site works at any GitHub Pages path
  base: "./",
  // honor an externally assigned port (e.g. preview tooling); default 5173
  server: { port: Number(process.env.PORT) || 5173 },
  build: { chunkSizeWarningLimit: 1500 },
});
