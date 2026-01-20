import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "../backend/OS/dist",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          ui: ["lucide-react", "react-icons"],
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
    host: "localhost",
    open: true,
    fs: {
      allow: ["../.."],
    },
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
