import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // React fast-refresh + JSX transform.
  plugins: [react()],
  // Serve static assets from /public at the project root.
  publicDir: "public",
  build: {
    // Emit frontend build into the backend's static dir.
    outDir: "../backend/OS/dist",
  },
  server: {
    // Local dev server defaults.
    port: 3000,
    host: "localhost",
    open: true,
    fs: {
      // Allow monorepo access for linked assets/configs.
      allow: ["../.."],
    },
    proxy: {
      // API proxy so the frontend can call the backend without CORS.
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
