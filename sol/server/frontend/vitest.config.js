import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react-router-dom", "lucide-react"],
  },
  server: {
    fs: { allow: [path.resolve(__dirname, "../../..")] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    env: { TZ: "UTC" },
    setupFiles: "./src/test/setup.js",
    css: false,
    include: ["src/**/*.test.{js,jsx}"],
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 60000,
    pool: "forks",
    maxForks: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{js,jsx}"],
      exclude: [
        "src/**/*.test.{js,jsx}",
        "src/test/**",
        "src/main.jsx",
        "src/assets/**",
      ],
      thresholds: { statements: 60, lines: 60 },
    },
  },
});
