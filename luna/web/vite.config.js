import fs from "fs";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev proxies in front of Vite (browser preview, port forwards) rewrite
// Host but leave Origin pointing at the outer port, so lunad's CSRF guard
// sees Origin != Host and 403s every POST through them. Rewrite Origin to
// the inbound Host on the way out so the guard always sees a match — dev
// only; the session-cookie CSRF token check still applies to authed
// mutations. Requests that sent no Origin (curl, device tokens) stay
// Origin-less, since lunad passes those through untouched.
const lunaProxy = (extra = {}) => ({
  target: "http://localhost:8090",
  changeOrigin: false,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq, req) => {
      if (req.headers.origin) {
        proxyReq.setHeader("origin", `http://${req.headers.host}`);
      }
    });
  },
  ...extra,
});

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react-router-dom", "lucide-react"],
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
    fs: {
      // Repo root: serves the symlinked @libreloom/ui package (shared/ui/)
      allow: ["../.."],
    },
    // Keep the browser Host header (changeOrigin: false). lunad's CSRF guard
    // compares Origin to Host; rewriting Host to :8090 makes every Vite-dev
    // POST look cross-site and returns 403 "Cross-site request blocked."
    proxy: {
      "/api": lunaProxy({ ws: true }),
      "/health": lunaProxy(),
      // Static EuroOffice pack + the docstorage socket from lunad. The editor
      // runs client-side; every asset and the WS live under /eurooffice.
      "/eurooffice": { target: "http://localhost:8090", changeOrigin: false, ws: true },
      // The editor iframe resolves ../../sdkjs/ against the site root
      // (Document Server's nginx layout) — lunad serves it from the pack.
      "/sdkjs": { target: "http://localhost:8090", changeOrigin: false },
      // sdkjs loads font metrics from site-root /fonts (same nginx layout).
      // Luna's brand fonts live in public/fonts — serve local files first;
      // only paths missing from public/ go to lunad's pack fonts dir.
      "/fonts": {
        target: "http://localhost:8090",
        changeOrigin: false,
        bypass: (req) => {
          const local = path.resolve(__dirname, "public", `.${req.url}`);
          if (fs.existsSync(local) && fs.statSync(local).isFile()) {
            return req.url;
          }
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    globals: true,
    include: ["src/**/*.test.{js,jsx}"],
  },
});
