// UAT suite for the ADMIN dashboard — exploratory tests, UX friction audits,
// and multi-page workflow validations against the PRODUCTION build (same
// bundle branches run). No live backend and no secrets: every network call is
// intercepted in e2e/fixtures.js (API mocked, Firebase/reCAPTCHA/socket.io
// blocked), so the suite is deterministic and safe to run anywhere.
// Run:  npm run build && npx playwright test   (or npm run e2e)
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // deterministic by design (all I/O mocked) — flakes are bugs
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // -s = SPA fallback so deep links like /admin/chats resolve to index.html,
    // exactly like the production host.
    command: "npx serve -s build -l 4174",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
