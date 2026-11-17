import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import sharedFonts from "../../../shared/ui/vite/sharedFonts.js";

export default defineConfig({
  plugins: [react(), tailwindcss(), sharedFonts()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Icons and the small UI parts load as one chunk instead of ~15
    // sub-kilobyte ones: each was its own request, and on HTTP/1.1 they
    // queued behind each other (C3 onboarding cold load, luna/perf/budgets.json).
    // One chunk, not two: the UI parts use icons and the split came out circular.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/lucide-react/") || id.includes("/src/components/ui/")) return "ui";
          return undefined;
        },
      },
    },
  },
  // Packages shared/ui imports resolve from this app's node_modules (shared/ui is never installed here).
  resolve: {
    dedupe: ["react", "react-dom", "react-router-dom", "lucide-react", "prop-types", "clsx", "class-variance-authority", "tailwind-merge", "@noble/ciphers", "@noble/curves", "@noble/hashes", "@noble/post-quantum", "@scure/bip39"],
  },
  server: {
    port: 3012,
    // Repo root: serves the symlinked @libreloom/ui package (shared/ui/)
    fs: { allow: ["../../.."] },
    proxy: { "/api": { target: "http://localhost:8092", changeOrigin: true } },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test/setup.js"] },
});
