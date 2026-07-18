import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  base: "/admin/",
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
      },
      "/api": {
        target: "http://localhost:8090",
      },
    },
  },
});
