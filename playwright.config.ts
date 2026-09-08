import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalTeardown: "./tests/e2e/playwright-teardown.ts",
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  webServer: { command: "npm run e2e:server", url: "http://localhost:3000", reuseExistingServer: false, timeout: 300_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
