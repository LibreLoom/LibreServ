import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import sharedFonts from "../../../shared/ui/vite/sharedFonts.js";

export default defineConfig({
  plugins: [react(), tailwindcss(), sharedFonts()],
  build: { outDir: "dist", emptyOutDir: true },
  // Packages shared/ui imports resolve from this app's node_modules (shared/ui is never installed here).
  resolve: {
    dedupe: ["react", "react-dom", "react-router-dom", "lucide-react", "prop-types", "clsx", "class-variance-authority", "tailwind-merge", "@noble/ciphers", "@noble/curves", "@noble/hashes", "@scure/bip39"],
  },
  server: {
    port: 3012,
    // Repo root: serves the symlinked @libreloom/ui package (shared/ui/)
    fs: { allow: ["../../.."] },
    proxy: { "/api": { target: "http://localhost:8092", changeOrigin: true } },
  },
  test: { environment: "jsdom", globals: true },
});
