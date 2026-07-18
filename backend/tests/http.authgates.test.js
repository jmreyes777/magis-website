// TST5.2/5.3 (testing megaplan): the gates in front of protected surface —
// admin/audit/backup endpoints must reject credential-less and garbage-token
// requests BEFORE any business logic, and the per-IP limiter must 429 once its
// budget is spent (in-memory store here; Redis in prod — same middleware).
//
// Contract style: assert 401/403 + a JSON error body, never a specific message
// (messages may improve; the status class and shape are the API contract).
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

describe("protected surface rejects credential-less requests (no 200, no 500)", () => {
  test("GET /api/admin/staff (staff management)", async () => {
    expectRejected(await request("/api/admin/staff"), "admin/staff");
  });

  test("GET /api/audit/events (audit log viewer)", async () => {
    expectRejected(await request("/api/audit/events"), "audit");
  });

  test("POST /api/backup/run (BDR2 trigger) without X-Obs-Auth or superadmin JWT", async () => {
    expectRejected(
      await request("/api/backup/run", { method: "POST" }),
      "backup/run"
    );
  });
});

describe("garbage bearer tokens are rejected, not crashed on", () => {
  const garbage = { headers: { Authorization: "Bearer not.a.real.token" } };

  test("GET /api/admin/staff with forged token", async () => {
    expectRejected(await request("/api/admin/staff", garbage), "admin/staff+garbage");
  });

  test("GET /api/audit/events with forged token", async () => {
    expectRejected(await request("/api/audit/events", garbage), "audit+garbage");
  });

  test("expired superadmin JWT → 401 'expired', NOT 500 (worker error-identity regression)", async () => {
    // Signed with the real pool + real secret, 1ms TTL: verification fails in
    // the WORKER with TokenExpiredError — whose name must survive the thread
    // boundary for authenticateSuperAdmin to map it to a clean 401. Before the
    // fix it arrived as a bare Error → 500 "Internal verification error".
    const { signJWT } = require("../utils/secretPool");
    const token = await signJWT({ role: "superadmin", email: "x@y.z" }, { expiresIn: "1ms" });
    await new Promise((r) => setTimeout(r, 50));
    const res = await request("/api/admin/staff", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401, `expected 401 for expired token, got ${res.status}`);
    assert.match(res.json.error, /expired/i);
  });
});

describe("per-IP rate limiting (guest contact relay, budget=1 in harness)", () => {
  test("second request in the window is 429 with the documented JSON message", async () => {
    const first = await request("/api/guest/contact", { method: "POST" });
    assert.notEqual(first.status, 429, "budget not yet spent");

    const second = await request("/api/guest/contact", { method: "POST" });
    assert.equal(second.status, 429);
    assert.match(second.json.error, /too many/i);
  });

  test("429 carries standard RateLimit headers (clients can show a real wait)", async () => {
    const res = await request("/api/guest/contact", { method: "POST" });
    assert.equal(res.status, 429);
    const hasStandard =
      res.headers.get("ratelimit-remaining") !== null ||
      res.headers.get("ratelimit") !== null; // draft-8 combined header
    assert.ok(hasStandard, "standardHeaders: true must emit RateLimit-* headers");
  });
});
