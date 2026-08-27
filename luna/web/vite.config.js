import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  publicDir: "public",
  build: {
    outDir: "../crates/lunad/web/dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          ui: ["lucide-react"],
          query: ["@tanstack/react-query"],
        },
      },
    },
    chunkSizeWarningLimit: 500,
    minify: "esbuild",
    cssMinify: true,
  },
  server: {
    port: Number(process.env.VITE_DEV_PORT) || 3001,
    strictPort: true,
    host: "0.0.0.0",
    open: false,
    allowedHosts: true,
    // Keep the browser Host header (changeOrigin: false). lunad's CSRF guard
    // compares Origin to Host; rewriting Host to :8090 makes every Vite-dev
    // POST look cross-site and returns 403 "Cross-site request blocked."
    proxy: {
      "/api": { target: "http://localhost:8090", changeOrigin: false },
      "/health": { target: "http://localhost:8090", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    globals: true,
  },
});
