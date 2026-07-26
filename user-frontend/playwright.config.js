// TST3 (testing megaplan): E2E smoke of the PRODUCTION build — the same
// prerendered HTML + hydration users and crawlers get. No secrets, no live
// backend: every network call leaves through fixtures.js mocks/blocks.
// Run:  npm run build && npx playwright test        (or npm run e2e)
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // ONE worker, on purpose: the UAT chat specs drive the full (heavy) bundle
  // through hydration + a socket handshake, and concurrent chromium instances
  // starve those windows into misfired clicks/timeouts (measured: 14/14 green
  // serial, variable failures at 2-4 workers). Whole suite still runs ~1 min.
  workers: 1,
  forbidOnly: !!process.env.CI, // a stray .only must never gut the suite in CI
  retries: 0, // deterministic by design (all I/O mocked) — flakes are bugs
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The workbox SW serves the cached "/" app shell for every navigation
    // after first install — multi-page tests would silently assert against
    // the homepage document (home title/canonical on /faqs etc.). Hermetic
    // suites test the network we mock, not the SW cache.
    serviceWorkers: "block",
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
