import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import sharedFonts from "../../../shared/ui/vite/sharedFonts.js";

export default defineConfig({
  plugins: [react(), tailwindcss(), sharedFonts()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 3012,
    proxy: { "/api": { target: "http://localhost:8092", changeOrigin: true } },
  },
  test: { environment: "jsdom", globals: true },
});
