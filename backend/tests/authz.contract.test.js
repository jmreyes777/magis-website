// SEC26 Wave 1: cross-tenant authorization proofs (OWASP 2025 A01 / API1 BOLA).
//
// Pins the role-boundary and claim-vs-param ownership properties so a future
// refactor can't silently drop them. Everything here is hermetic (no
// Firestore): each assertion targets a check that fires BEFORE any data access
// — role gates inside auth middlewares, and ensureGuestOwns/ensureBranchOwns
// comparisons. Ownership checks that require reading the object first
// (media/:id, admin-media/:id, push unsubscribe) are covered by the Firestore
// emulator suite (A01-4) and asserted here only as "authed-but-wrong-role is
// rejected".
//
// Companion matrix: tests/AUTHZ-MATRIX.md
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { request, stop } = require("./httpHarness");
const { signJWT } = require("../utils/secretPool");

after(async () => {
  await stop();
});

// ── Identity fixtures (real signed tokens, real verification path) ─────────
const GUEST_A = { role: "user", guestId: "guest-authz-a", email: "branch-1@test.local" };
const GUEST_B_ID = "guest-authz-b";
const BRANCH_1 = {
  role: "branchadmin",
  email: "branch-1@test.local",
  branchEmail: "branch-1@test.local",
  branchId: "branch-1",
  branchName: "Branch One",
};
const BRANCH_2_EMAIL = "branch-2@test.local";
const SUPER = { role: "superadmin", email: "root@test.local" };

const asGuest = async () => `Bearer ${await signJWT(GUEST_A, { expiresIn: "5m" })}`;
const asBranch = async () => `Bearer ${await signJWT(BRANCH_1, { expiresIn: "5m" })}`;
const asSuper = async () => `Bearer ${await signJWT(SUPER, { expiresIn: "5m" })}`;

const expectDenied = (res, label) => {
  assert.ok(
    [401, 403].includes(res.status),
    `${label}: expected 401/403, got ${res.status}`
  );
  assert.equal(typeof res.json?.error, "string", `${label}: JSON error shape`);
};

// ── 1. Role boundaries: guest tokens on staff surface ───────────────────────
describe("A01: guest tokens are rejected on staff surface (role gate, pre-data)", () => {
  const staffRoutes = [
    ["/api/messages/history/any-guest", "GET"],
    ["/api/messages/admin-media/msg-1", "GET"],
    ["/api/messages/conversation-key/any-guest", "GET"],
    ["/api/analytics/message-volume", "GET"],
    ["/api/analytics/csat-summary", "GET"],
    ["/api/push/public-key", "GET"],
  ];
  for (const [path, method] of staffRoutes) {
    test(`guest → ${method} ${path}`, async () => {
      const res = await request(path, { method, headers: { Authorization: await asGuest() } });
      expectDenied(res, `guest→${path}`);
    });
  }
});

// ── 2. Role boundaries: branchadmin tokens on superadmin surface ────────────
describe("A01/BFLA: branchadmin tokens are rejected on superadmin surface", () => {
  const superRoutes = [
    ["/api/messages/all", "GET"],
    ["/api/analytics/branch-performance", "GET"],
  ];
  for (const [path, method] of superRoutes) {
    test(`branchadmin → ${method} ${path}`, async () => {
      const res = await request(path, { method, headers: { Authorization: await asBranch() } });
      expectDenied(res, `branch→${path}`);
    });
  }
});

// ── 3. Role boundaries: superadmin is NOT implicitly a branch admin ─────────
describe("A01: superadmin tokens do not pass branch-scoped gates", () => {
  test("superadmin → GET /api/messages/history/:guestId", async () => {
    const res = await request("/api/messages/history/any-guest", {
      headers: { Authorization: await asSuper() },
    });
    expectDenied(res, "super→history");
  });

  test("superadmin → GET /api/push/public-key (branch-scoped subscription surface)", async () => {
    const res = await request("/api/push/public-key", {
      headers: { Authorization: await asSuper() },
    });
    expectDenied(res, "super→push");
  });
});

// ── 4. BOLA: claim-vs-param ownership (ensureGuestOwns / ensureBranchOwns) ──
describe("BOLA: token claim vs request param mismatches are 403", () => {
  test("guest A sending as guest B → 403 guestId mismatch", async () => {
    const res = await request("/api/messages/send", {
      method: "POST",
      headers: {
        Authorization: await asGuest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ guestId: GUEST_B_ID, content: "spoof attempt" }),
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /mismatch|forbidden/i);
  });

  test("branch 1 replying as branch 2 → 403 branchEmail mismatch", async () => {
    const res = await request("/api/messages/reply", {
      method: "POST",
      headers: {
        Authorization: await asBranch(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guestId: "any-guest",
        content: "spoof attempt",
        branchEmail: BRANCH_2_EMAIL,
      }),
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /mismatch|forbidden/i);
  });

  test("matching claims pass the ownership gate (send reaches business logic)", async () => {
    const res = await request("/api/messages/send", {
      method: "POST",
      headers: {
        Authorization: await asGuest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ guestId: GUEST_A.guestId, content: "legit" }),
    });
    // Gate passed → handler ran → Firestore unavailable in tests → 500.
    // Contract: NOT rejected by the ownership layer.
    assert.notEqual(res.status, 403);
  });
});

// ── 5. BOPLA guard: error responses never leak internals ────────────────────
describe("BOPLA/A10: denial responses carry only the error contract", () => {
  test("403 bodies contain no stack, no token echo, no internal fields", async () => {
    const res = await request("/api/messages/reply", {
      method: "POST",
      headers: { Authorization: await asBranch(), "Content-Type": "application/json" },
      body: JSON.stringify({ guestId: "g", content: "x", branchEmail: BRANCH_2_EMAIL }),
    });
    assert.equal(res.status, 403);
    const keys = Object.keys(res.json);
    assert.deepEqual(keys, ["error"], `unexpected fields in denial body: ${keys}`);
    assert.ok(!/at\s+\w+\s+\(/.test(res.text), "no stack traces in body");
    assert.ok(!res.text.includes("Bearer"), "no token echo in body");
  });
});
