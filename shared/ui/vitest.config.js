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
    // Heavy jsdom card tests take a second alone and several times that when
    // every worker is busy; the 5s default flaked on a loaded machine.
    testTimeout: 20000,
  },
});
