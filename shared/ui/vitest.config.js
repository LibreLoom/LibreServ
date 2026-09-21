import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./test/setup.js",
    css: false,
    include: ["**/*.test.{js,jsx}"],
    exclude: ["node_modules/**"],
  },
});
