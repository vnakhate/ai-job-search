import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  expect: { timeout: 10000 },
  // Deliberately never reuse the user's demo server or persistent state.
  webServer: {
    command: "node scripts/uat-server.mjs",
    url: "http://localhost:8798/api/health",
    reuseExistingServer: false,
    timeout: 90000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
  use: {
    baseURL: "http://localhost:8798",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(process.env.UAT_BROWSER_CHANNEL
      ? { channel: process.env.UAT_BROWSER_CHANNEL }
      : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
});
