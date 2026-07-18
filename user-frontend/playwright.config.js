// TST3 (testing megaplan): E2E smoke of the PRODUCTION build — the same
// prerendered HTML + hydration users and crawlers get. No secrets, no live
// backend: every network call leaves through fixtures.js mocks/blocks.
// Run:  npm run build && npx playwright test        (or npm run e2e)
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI, // a stray .only must never gut the suite in CI
  retries: 0, // deterministic by design (all I/O mocked) — flakes are bugs
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // -s = SPA fallback; prerendered per-route index.html files still win for
    // the routes that have them (exactly like the production edge).
    command: "npx serve -s build -l 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
