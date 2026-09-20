import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 3012,
    proxy: { "/api": { target: "http://localhost:8092", changeOrigin: true } },
  },
  test: { environment: "jsdom", globals: true },
});
