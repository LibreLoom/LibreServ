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
    port: 3000,
    strictPort: true,
    host: "0.0.0.0",
    open: false,
    allowedHosts: true,
    proxy: {
      "/api": { target: "http://localhost:8090", changeOrigin: true },
      "/health": { target: "http://localhost:8090", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    globals: true,
  },
});
