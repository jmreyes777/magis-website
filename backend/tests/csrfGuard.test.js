// SEC26 Wave 0 (CSRF-1): the double-submit token is no longer decorative.
//
// Two layers:
//   1. Unit — csrfGuard's decision table (method × token presence × enforce flag).
//   2. HTTP — through the REAL app: a cookie-authenticated mutating request
//      without a matching X-CSRF-Token is 403'd in enforce mode BEFORE any
//      business logic (no Firestore in the test env — a 403 here proves the
//      guard fired first). Header-auth flows must be completely unaffected.
const { test, describe, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { csrfGuard, tokensMatch } = require("../middlewares/csrfGuard");
const { request, stop } = require("./httpHarness");
const { signJWT } = require("../utils/secretPool");

after(async () => {
  await stop();
});

// ── Layer 1: unit decision table ────────────────────────────────────────────

function fakeReqRes({ method = "POST", header, cookie } = {}) {
  const req = {
    method,
    originalUrl: "/api/test",
    get: (name) => (name.toLowerCase() === "x-csrf-token" ? header : undefined),
    cookies: cookie !== undefined ? { csrfToken: cookie } : {},
  };
  let statusCode = null;
  let body = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { body = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return { req, res };
}

describe("csrfGuard unit decision table", () => {
  beforeEach(() => { delete process.env.CSRF_ENFORCE; });

  test("GET is never guarded regardless of tokens", () => {
    process.env.CSRF_ENFORCE = "true";
    const { req, res } = fakeReqRes({ method: "GET" });
    assert.equal(csrfGuard(req, res), null);
    assert.equal(res.statusCode, null);
  });

  test("matching header+cookie passes in enforce mode", () => {
    process.env.CSRF_ENFORCE = "true";
    const t = "a".repeat(64);
    const { req, res } = fakeReqRes({ header: t, cookie: t });
    assert.equal(csrfGuard(req, res), null);
  });

  test("missing header → 403 in enforce mode", () => {
    process.env.CSRF_ENFORCE = "true";
    const { req, res } = fakeReqRes({ cookie: "c".repeat(64) });
    assert.equal(csrfGuard(req, res), true);
    assert.equal(res.statusCode, 403);
    assert.equal(typeof res.body.error, "string");
  });

  test("mismatched tokens → 403 in enforce mode", () => {
    process.env.CSRF_ENFORCE = "true";
    const { req, res } = fakeReqRes({ header: "a".repeat(64), cookie: "b".repeat(64) });
    assert.equal(csrfGuard(req, res), true);
    assert.equal(res.statusCode, 403);
  });

  test("monitor mode (default): mismatch logs but passes", () => {
    const { req, res } = fakeReqRes({ header: "", cookie: "" });
    assert.equal(csrfGuard(req, res), null);
    assert.equal(res.statusCode, null);
  });

  test("tokensMatch is length-safe and rejects empties", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
    assert.equal(tokensMatch("abc", "abd"), false);
    assert.equal(tokensMatch("abc", "abcd"), false);
    assert.equal(tokensMatch("", ""), false);
    assert.equal(tokensMatch(null, null), false);
  });
});

// ── Layer 2: HTTP contracts through the real app ────────────────────────────

const GUEST = { role: "user", guestId: "guest-csrf-test", email: "branch@test.local" };

describe("CSRF-1 HTTP contract (cookie-auth mutating requests)", () => {
  beforeEach(() => { delete process.env.CSRF_ENFORCE; });

  test("enforce: guest cookie + no CSRF header → 403 before business logic", async () => {
    process.env.CSRF_ENFORCE = "true";
    const token = await signJWT(GUEST, { expiresIn: "5m" });
    const res = await request("/api/messages/mark-seen-by-guest/some-id", {
      method: "PATCH",
      headers: { Cookie: `guestToken=${token}` },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /CSRF/i);
  });

  test("enforce: guest cookie + matching double-submit → guard passes (not 403-by-CSRF)", async () => {
    process.env.CSRF_ENFORCE = "true";
    const token = await signJWT(GUEST, { expiresIn: "5m" });
    const csrf = "f".repeat(64);
    const res = await request("/api/messages/mark-seen-by-guest/some-id", {
      method: "PATCH",
      headers: {
        Cookie: `guestToken=${token}; csrfToken=${csrf}`,
        "X-CSRF-Token": csrf,
      },
    });
    // Guard passed → handler ran → Firestore is unavailable in tests → 500.
    // The contract here is ONLY "not rejected as CSRF".
    assert.notEqual(res.status, 403);
  });

  test("enforce: Bearer-header auth is exempt (no CSRF header needed)", async () => {
    process.env.CSRF_ENFORCE = "true";
    const token = await signJWT(GUEST, { expiresIn: "5m" });
    const res = await request("/api/messages/mark-seen-by-guest/some-id", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.notEqual(res.status, 403);
  });

  test("monitor (default): cookie without CSRF header proceeds", async () => {
    const token = await signJWT(GUEST, { expiresIn: "5m" });
    const res = await request("/api/messages/mark-seen-by-guest/some-id", {
      method: "PATCH",
      headers: { Cookie: `guestToken=${token}` },
    });
    assert.notEqual(res.status, 403);
  });
});
