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
    outDir: "../backend/OS/dist",
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
    fs: {
      allow: ["../.."],
    },
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            proxyReq.setHeader("X-Forwarded-For", req.socket?.remoteAddress || "");
          });
        },
      },
      "/health": {
        target: "http://localhost:8080",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            proxyReq.setHeader("X-Forwarded-For", req.socket?.remoteAddress || "");
          });
        },
      },
      // OIDC provider endpoints — served by the backend, not the SPA.
      "/.well-known": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/authorize": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/oauth": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/userinfo": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/revoke": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/end_session": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/keys": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
