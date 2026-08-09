// SEC26 Wave 0 (A06-1): hot-read endpoints now carry an origin-side budget.
//
// In the hermetic test env the limiter uses express-rate-limit's in-memory
// store (no REDIS_URL) — same middleware object that runs Redis-backed in
// prod. We shrink the budget via env BEFORE the app loads so a handful of
// requests can exercise the 429 contract.
process.env.HOT_READ_RL_MAX = "3"; // tiny budget for the contract test
process.env.HOT_READ_RL_WINDOW_MS = "600000";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { request, stop } = require("./httpHarness");
const { signJWT } = require("../utils/secretPool");

after(async () => {
  await stop();
});

const GUEST = { role: "user", guestId: "guest-hotread-test", email: "branch@test.local" };

describe("A06-1: /api/messages/media/:id per-identity budget", () => {
  test("429 with JSON error once the identity's budget is spent; standard headers present", async () => {
    const token = await signJWT(GUEST, { expiresIn: "5m" });
    const call = () =>
      request("/api/messages/media/msg-1", {
        headers: { Authorization: `Bearer ${token}` },
      });

    // Budget is 3: the first three requests reach the handler (Firestore is
    // unavailable in tests → 500; the contract here is "not 429").
    for (let i = 0; i < 3; i += 1) {
      const r = await call();
      assert.notEqual(r.status, 429, `request ${i + 1} should be within budget`);
    }

    const limited = await call();
    assert.equal(limited.status, 429);
    assert.equal(typeof limited.json.error, "string");
    assert.ok(limited.headers.get("ratelimit-limit"), "standardHeaders exposed");
  });

  test("a different identity has an independent budget", async () => {
    const other = await signJWT(
      { role: "user", guestId: "guest-hotread-other", email: "branch@test.local" },
      { expiresIn: "5m" }
    );
    const r = await request("/api/messages/media/msg-1", {
      headers: { Authorization: `Bearer ${other}` },
    });
    assert.notEqual(r.status, 429, "fresh identity must not inherit the spent budget");
  });
});
