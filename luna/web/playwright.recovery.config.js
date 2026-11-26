import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  reporter: "list",
  // The first page load compiles the app in Vite while the box is busy; the
  // default 5s expectation can lose that race even though the page is fine.
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:19400",
    browserName: "chromium",
    headless: true,
    acceptDownloads: true,
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 19400 --strictPort",
    url: "http://127.0.0.1:19400/recover",
    env: { VITE_LUNAD_TARGET: "http://127.0.0.1:19401" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
