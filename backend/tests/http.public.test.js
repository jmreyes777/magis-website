// TST5.1 (testing megaplan): public HTTP contracts through the REAL app —
// CSRF token issuance, the security-header envelope every response carries,
// BREACH compression exclusion, and the JSON 404 for unmatched API routes.
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { request, stop } = require("./httpHarness");

after(async () => {
  await stop();
});

describe("GET /api/csrf-token (A03-1b double-submit issuance)", () => {
  test("200 with a 64-hex token, mirrored into a readable Strict cookie, never cached", async () => {
    const res = await request("/api/csrf-token");
    assert.equal(res.status, 200);
    assert.match(res.json.csrfToken, /^[0-9a-f]{64}$/);

    const setCookie = res.headers.get("set-cookie") || "";
    assert.ok(setCookie.includes(`csrfToken=${res.json.csrfToken}`), "cookie carries the same token");
    assert.match(setCookie, /SameSite=Strict/i);
    assert.ok(!/HttpOnly/i.test(setCookie), "cookie must stay JS-readable (double-submit contract)");

    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("every call issues a fresh random token", async () => {
    const [a, b] = [await request("/api/csrf-token"), await request("/api/csrf-token")];
    assert.notEqual(a.json.csrfToken, b.json.csrfToken);
  });

  test("BREACH hardening: response is never compressed even when the client asks", async () => {
    const res = await request("/api/csrf-token", {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), null);
  });
});

describe("security-header envelope (helmet + custom middleware)", () => {
  // NOTE (found by this suite): /api/csrf-token is registered BEFORE helmet in
  // server.js, so that one route carries no CSP/nosniff envelope. Everything
  // registered after helmet — the actual API surface, asserted here via the
  // tail 404 handler — must carry the full envelope.
  const PATH = "/api/security-envelope-probe";

  test("CSP with per-request nonce, nosniff, frame-ancestors 'none', Permissions-Policy, Alt-Svc h3", async () => {
    const res = await request(PATH);
    const csp = res.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"), `CSP default-src (got: ${csp.slice(0, 120) || "no header"})`);
    assert.match(csp, /'nonce-[A-Za-z0-9+/=]+'/, "per-request script nonce");
    assert.ok(csp.includes("frame-ancestors 'none'"), "clickjacking lockout");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
    assert.match(res.headers.get("alt-svc") || "", /h3=/);
  });

  test("nonce differs per request (no replayable CSP)", async () => {
    const nonceOf = (r) => (r.headers.get("content-security-policy") || "").match(/'nonce-([^']+)'/)?.[1];
    const [a, b] = [await request(PATH), await request(PATH)];
    assert.ok(nonceOf(a) && nonceOf(b));
    assert.notEqual(nonceOf(a), nonceOf(b));
  });
});

describe("unmatched API routes (A10-2)", () => {
  test("JSON 404 — machine-readable, no SPA index.html fallthrough", async () => {
    const res = await request("/api/definitely-not-a-route");
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: "Not found" });
  });

  test("unknown nested paths under real routers also 404 as JSON", async () => {
    const res = await request("/api/guest/definitely-not-a-route");
    assert.equal(res.status, 404);
    assert.equal(typeof res.json, "object");
  });
});
