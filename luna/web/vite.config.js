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
      "/api": { target: "http://localhost:8090", changeOrigin: false, ws: true },
      "/health": { target: "http://localhost:8090", changeOrigin: false },
      // Static EuroOffice pack (and SPA fallback) from lunad.
      "/eurooffice": { target: "http://localhost:8090", changeOrigin: false },
      // When a local Document Server is running (:8088) for DocsAPI runtime
      // paths that api.js requests from the site origin, forward them.
      "/sdkjs": { target: "http://127.0.0.1:8088", changeOrigin: true },
      "/fonts": { target: "http://127.0.0.1:8088", changeOrigin: true },
      "/dictionaries": { target: "http://127.0.0.1:8088", changeOrigin: true },
      "/coauthoring": { target: "http://127.0.0.1:8088", changeOrigin: true, ws: true },
      "/cache": { target: "http://127.0.0.1:8088", changeOrigin: true },
      "/doc": { target: "http://127.0.0.1:8088", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    globals: true,
  },
});
