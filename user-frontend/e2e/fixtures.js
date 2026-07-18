// TST3 (testing megaplan): shared E2E fixtures.
//
// 1. Hermetic network: same-origin /api/** answered with minimal JSON mocks;
//    socket.io and ALL cross-origin calls (Firestore, Turnstile, Facebook,
//    fonts, maps) are aborted. The suite needs no credentials and no internet
//    beyond localhost — pages must degrade gracefully, which is itself part
//    of what we assert.
// 2. Error tripwire: any UNCAUGHT page exception or React hydration complaint
//    fails the test. Console noise from our own deliberate blocking (aborted
//    fetches, Firestore backoff, ad-block-style failures) is whitelisted.
const base = require("@playwright/test");

// Minimal happy-path mocks per API family; default is an empty JSON object.
const API_MOCKS = [
  { match: /\/api\/csrf-token/, body: { csrfToken: "e2e-csrf-token" } },
  { match: /\/api\/site-config/, body: {} },
  { match: /\/api\/facebook/, body: { data: [] } },
  { match: /\/api\/branch-status/, body: {} },
  { match: /\/api\/guest/, body: { ok: true } },
  { match: /\/api\/rum|\/api\/client-errors/, body: { ok: true } },
];

// Console/page noise that our own network blocking legitimately produces.
const BENIGN = [
  /Failed to load resource/i, // any aborted request logs this
  /net::ERR_/i,
  /ERR_BLOCKED_BY_CLIENT|ERR_FAILED|ERR_ABORTED/i,
  /firestore/i, // SDK backoff chatter while blocked
  /transport errored|WebChannelConnection/i,
  /turnstile|challenges\.cloudflare/i,
  /facebook|fb\.watch/i,
  /socket\.io|websocket/i,
  /google.*maps|staticmap/i,
  /favicon/i,
  /Manifest/i,
];
const isBenign = (text) => BENIGN.some((re) => re.test(text));

// Signals that MUST fail a spec even though they arrive via console.error.
const FATAL_CONSOLE = [
  /hydration/i,
  /Minified React error #(418|419|422|423|425)/, // hydration/render family
  /Cannot read propert/i,
  /is not a function/i,
];

const test = base.test.extend({
  page: async ({ page, context }, use, testInfo) => {
    const violations = [];

    // ── hermetic network ──────────────────────────────────────────────────
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (!url.startsWith("http://localhost:4173")) return route.abort();
      if (url.includes("/socket.io")) return route.abort();
      if (url.includes("/api/")) {
        const mock = API_MOCKS.find((m) => m.match.test(url));
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mock ? mock.body : {}),
        });
      }
      return route.continue(); // static assets from the build
    });

    // ── error tripwire ────────────────────────────────────────────────────
    page.on("pageerror", (err) => {
      if (!isBenign(String(err.message))) violations.push(`pageerror: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error" && msg.type() !== "warning") return;
      const text = msg.text();
      if (FATAL_CONSOLE.some((re) => re.test(text)) && !isBenign(text)) {
        violations.push(`console.${msg.type()}: ${text}`);
      }
    });

    await use(page);

    if (violations.length) {
      throw new Error(
        `Page error tripwire (${testInfo.title}):\n  ${violations.join("\n  ")}`
      );
    }
  },
});

module.exports = { test, expect: base.expect };
