// UAT suite for the ADMIN dashboard — exploratory tests, UX friction audits,
// and multi-page workflow validations against the PRODUCTION build (same
// bundle branches run). No live backend and no secrets: every network call is
// intercepted in e2e/fixtures.js (API mocked, Firebase/reCAPTCHA/socket.io
// blocked), so the suite is deterministic and safe to run anywhere.
// Run:  npm run build && npx playwright test   (or npm run e2e)
const { defineConfig, devices } = require("@playwright/test");

// CHAT-PARK: two suites, one testDir. The default (parked) build skips the
// UAT specs that drive the chat dashboard (uat-01..06 login→dashboard flows
// and uat-09 a11y which exercises chat UI) — those need a chat-on build
// (`npm run build:chat && npm run e2e:chat`). The chat-on run inverts it:
// chat suites stay green and only chat-off.spec.js (parked UI) is skipped.
const CHAT_ENABLED = process.env.REACT_APP_CHAT_ENABLED === "true";

module.exports = defineConfig({
  testDir: "./e2e",
  testIgnore: CHAT_ENABLED
    ? ["**/chat-off.spec.js"]
    : [
        "**/uat-01-*.spec.js",
        "**/uat-02-*.spec.js",
        "**/uat-03-*.spec.js",
        "**/uat-04-*.spec.js",
        "**/uat-05-*.spec.js",
        "**/uat-06-*.spec.js",
        "**/uat-09-*.spec.js",
      ],
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
