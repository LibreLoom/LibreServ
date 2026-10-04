import fs from "fs";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import sharedFonts from "../../shared/ui/vite/sharedFonts.js";

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

// Excalidraw fetches its canvas fonts at runtime from
// window.EXCALIDRAW_ASSET_PATH (default: a CDN). Luna serves them itself —
// dev reads straight from node_modules, the build copies them into dist so
// lunad's embedded web root carries them. Nothing leaves the device.
const EXCALIDRAW_PACK = path.resolve(
  __dirname,
  "node_modules/@excalidraw/excalidraw/dist/prod",
);

const excalidrawAssets = () => ({
  name: "luna-excalidraw-assets",
  configureServer(server) {
    server.middlewares.use("/excalidraw", (req, res, next) => {
      const rel = decodeURIComponent((req.url || "").split("?")[0]);
      const file = path.join(EXCALIDRAW_PACK, rel);
      const stat =
        file.startsWith(EXCALIDRAW_PACK + path.sep) &&
        fs.statSync(file, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) return next();
      if (file.endsWith(".woff2")) res.setHeader("content-type", "font/woff2");
      fs.createReadStream(file).pipe(res);
    });
  },
  closeBundle() {
    fs.cpSync(
      path.join(EXCALIDRAW_PACK, "fonts"),
      path.resolve(__dirname, "../crates/lunad/web/dist/excalidraw/fonts"),
      { recursive: true },
    );
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawAssets(), sharedFonts()],
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
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "vendor";
          if (id.includes("node_modules/lucide-react/")) return "ui";
          if (id.includes("node_modules/@tanstack/")) return "query";
          return undefined;
        },
        // Excalidraw is a lazy chunk that only downloads on open. A manual
        // chunk would drag shared helpers into it and make the entry preload
        // it, so just name the dynamic chunk: lunad's system check looks for
        // assets/excalidraw-*.js.
        chunkFileNames(chunk) {
          const isExcalidraw = chunk.facadeModuleId?.includes(
            "node_modules/@excalidraw/excalidraw/");
          return isExcalidraw
            ? "assets/excalidraw-[hash].js"
            : "assets/[name]-[hash].js";
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
      // Public share links live on lunad under /s/{token}. Navigations to the
      // link root stay on Vite so the dev build renders the share page; data
      // fetches (Accept: json) and sub-resources (list/file/media/zip/upload/
      // respond) always proxy through.
      "/s/": lunaProxy({
        bypass: (req) => {
          const pathname = (req.url || "").split("?")[0];
          const isRootNav = /^\/s\/[^/]+$/.test(pathname);
          return isRootNav && req.headers.accept?.includes("text/html")
            ? req.url
            : undefined;
        },
      }),
      // Static EuroOffice pack + the docstorage socket from lunad. The editor
      // runs client-side; every asset and the WS live under /eurooffice.
      "/eurooffice": { target: "http://localhost:8090", changeOrigin: false, ws: true },
      // The editor iframe resolves ../../sdkjs/ against the site root
      // (Document Server's nginx layout) — lunad serves it from the pack.
      "/sdkjs": { target: "http://localhost:8090", changeOrigin: false },
      // Static draw.io webapp pack from lunad (self-hosted diagrams.net —
      // the editor iframe is same-origin, no websocket needed).
      "/drawio": { target: "http://localhost:8090", changeOrigin: false },
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
