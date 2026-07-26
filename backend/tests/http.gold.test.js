// Auth gates for the gold pricing intel API (routes/gold.js) — same contract
// style as http.authgates.test.js: status class + JSON error shape, never
// specific messages. Business logic (Firestore) is unreachable in this
// harness; every assertion here fires BEFORE it.
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { request, stop } = require("./httpHarness");

after(async () => {
  await stop();
});

const expectRejected = (res, label) => {
  assert.ok([401, 403].includes(res.status), `${label}: expected 401/403, got ${res.status}`);
  assert.equal(typeof res.json?.error, "string", `${label}: JSON error body`);
};

describe("gold API rejects credential-less and garbage requests", () => {
  test("GET /api/gold/summary without a token", async () => {
    expectRejected(await request("/api/gold/summary"), "gold/summary");
  });

  test("POST /api/gold/baseline without a token", async () => {
    expectRejected(
      await request("/api/gold/baseline", { method: "POST" }),
      "gold/baseline"
    );
  });

  test("GET /api/gold/summary with a forged token", async () => {
    expectRejected(
      await request("/api/gold/summary", {
        headers: { Authorization: "Bearer not.a.real.token" },
      }),
      "gold/summary+garbage"
    );
  });
});

describe("baseline writes are management-only", () => {
  test("staff session (role branchadmin + staff:true) → 403 before any storage touch", async () => {
    const { signJWT } = require("../utils/secretPool");
    const token = await signJWT(
      {
        role: "branchadmin",
        email: "branch1@magis.test",
        branchId: "b1",
        branchName: "Branch One",
        staff: true,
        fallback: true,
      },
      { expiresIn: "5m" }
    );
    const res = await request("/api/gold/baseline", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ thresholdPct: 2 }),
    });
    assert.equal(res.status, 403, `expected 403 for staff, got ${res.status}`);
    assert.match(res.json.error, /management/i);
  });

  test("management session with an invalid threshold → 400 (validation precedes storage)", async () => {
    const { signJWT } = require("../utils/secretPool");
    const token = await signJWT(
      {
        role: "branchadmin",
        email: "admin1@magis.test",
        branchId: "b1",
        branchName: "Branch One",
        fallback: true,
      },
      { expiresIn: "5m" }
    );
    const res = await request("/api/gold/baseline", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ thresholdPct: 99 }),
    });
    assert.equal(res.status, 400, `expected 400 for bad threshold, got ${res.status}`);
    assert.match(res.json.error, /threshold/i);
  });
});
