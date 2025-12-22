import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../backend/OS/dist",
  },
  server: {
    port: 3000,
    host: "localhost",
    open: true,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
    port: 3000,
    host: "localhost",
    open: true,
    proxy: {
      "/health": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
