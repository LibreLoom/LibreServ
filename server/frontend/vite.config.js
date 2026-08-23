import fs from "fs";
import path from "path";
import zlib from "zlib";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Precompress build output so the backend's .gz fast path (serveStaticPath)
// can serve gzip without paying per-request compression cost. Only writes a
// .gz sibling when it actually saves bytes.
function gzipAssets() {
  const compress = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        compress(full);
        continue;
      }
      if (full.endsWith(".gz") || !/\.(js|css|html|svg|json|txt|map)$/.test(entry.name)) {
        continue;
      }
      const data = fs.readFileSync(full);
      if (data.length < 1024) continue;
      const gz = zlib.gzipSync(data, { level: 9 });
      if (gz.length < data.length) {
        fs.writeFileSync(full + ".gz", gz);
      }
    }
  };
  return {
    name: "gzip-assets",
    apply: "build",
    closeBundle() {
      compress(path.resolve(__dirname, "../backend/OS/dist"));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), gzipAssets()],
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
