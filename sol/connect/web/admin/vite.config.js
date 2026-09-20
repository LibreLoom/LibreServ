import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "dist",
    minify: "esbuild",
    cssMinify: true,
  },
  server: {
    port: 3002,
    strictPort: true,
    proxy: {
      "/admin": {
        target: "http://localhost:8090",
        changeOrigin: true,
        // The Go server mounts the admin API under /admin — the same prefix
        // this app is served from (base + router basename). Proxying the whole
        // prefix handed Vite's own documents and modules to Go, which 404s them
        // in dev because web/admin/dist isn't built. The API client always asks
        // for application/json, so forward only those and let Vite keep the rest.
        bypass: (req) =>
          req.headers.accept?.includes("application/json") ? undefined : req.url,
      },
      "/api": {
        target: "http://localhost:8090",
      },
    },
  },
});
