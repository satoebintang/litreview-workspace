import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-diagnostics",
  fullyParallel: false,
  workers: 1,
  timeout: 15_000,
  expect: { timeout: 2_000 },
  retries: 0,
  reporter: "list",
  outputDir: process.env.PLAYWRIGHT_DIAGNOSTICS_OUTPUT_DIR ?? "test-results-diagnostics",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
