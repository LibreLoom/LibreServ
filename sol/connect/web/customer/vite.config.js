import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    minify: "esbuild",
    cssMinify: true,
  },
  server: {
    port: 3001,
    strictPort: true,
    proxy: {
      "/portal": {
        target: "http://localhost:8090",
        changeOrigin: true,
      },
      "/api": {
        target: "http://localhost:8090",
      },
    },
  },
});
