import { defineConfig } from "@playwright/test";

// Journey timings against a real Luna (see luna/perf/README.md → Web).
// No webServer: the dev server boots the fake lunad and adds StrictMode and
// unminified code, so the numbers would not mean anything. Point
// LUNA_PERF_BASE_URL at a lunad serving the built web app.
const baseURL = process.env.LUNA_PERF_BASE_URL || "http://127.0.0.1:8090";

// One id for the whole run, set before workers start so every worker (and a
// worker restarted after a failure) writes into the same results file.
process.env.LUNA_PERF_RUN_ID ||= new Date().toISOString().replace(/[:.]/g, "-");

export default defineConfig({
  testDir: "./perf",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // Journeys loop N times each; a cold load on a throttled CPU is slow.
  timeout: 15 * 60_000,
  use: {
    baseURL,
    browserName: "chromium",
    headless: process.env.LUNA_PERF_HEADED !== "1",
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  },
});
