// SEC26 Wave 2 (A02/A10): misconfiguration hardening contracts.
//
//   1. Oversized JSON bodies 413 at the parser — before auth, before handlers.
//   2. /api responses default to Cache-Control: no-store (authed surface must
//      never be cacheable); explicitly-cached public routes still override.
//   3. Error responses stay inside the JSON error contract (no HTML, no stack).
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { request, stop } = require("./httpHarness");

after(async () => {
  await stop();
});

describe("A02: JSON body limit (default 200kb, JSON_BODY_LIMIT-tunable)", () => {
  test("oversized JSON → 413 before any handler/auth work", async () => {
    const big = JSON.stringify({ pad: "x".repeat(300 * 1024) }); // 300kb > 200kb
    const res = await request("/api/guest/csat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    assert.equal(res.status, 413);
  });

  test("normal-sized JSON still parses (401 from auth, not 413)", async () => {
    const res = await request("/api/guest/csat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5 }),
    });
    assert.notEqual(res.status, 413);
  });
});

describe("A02: /api Cache-Control defaults to no-store", () => {
  test("authed endpoint denial carries no-store", async () => {
    const res = await request("/api/admin/staff");
    assert.ok([401, 403].includes(res.status));
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("unmatched /api route (404 tail) carries no-store", async () => {
    const res = await request("/api/definitely-not-a-route");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("publicCache overrides the no-store default on 2xx (real middleware, server order)", () => {
    // No public cached route can reach 2xx in the hermetic env (they all need
    // Redis/Firestore), so prove the layering property directly: the /api
    // default runs first, publicCache's json-wrap then replaces it on success.
    const publicCache = require("../middlewares/publicCache");
    const headers = {};
    const res = {
      statusCode: 200,
      set(k, v) { headers[k.toLowerCase()] = v; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      vary() {},
      json(b) { return b; },
    };
    res.json = res.json.bind(res);
    // Server order: default first…
    res.set("Cache-Control", "no-store");
    // …then the route-mounted publicCache wraps res.json.
    publicCache(300, 600)({ method: "GET" }, res, () => {});
    res.json({ ok: true });
    assert.equal(headers["cache-control"], "public, max-age=300, s-maxage=600");
  });
});

describe("A10: parser/limit errors stay in the JSON contract (no HTML, no stack)", () => {
  test("413 body is not an HTML error page and leaks no stack frames", async () => {
    const big = JSON.stringify({ pad: "y".repeat(300 * 1024) });
    const res = await request("/api/guest/csat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    assert.equal(res.status, 413);
    assert.ok(!res.text.toLowerCase().includes("<html"), "no HTML error page");
    assert.ok(!/at\s+\w+\s+\(/.test(res.text), "no stack trace in body");
  });

  test("malformed JSON → 4xx JSON error, not a crash or HTML page", async () => {
    const res = await request("/api/guest/csat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });
    assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
    assert.ok(!res.text.toLowerCase().includes("<html"), "no HTML error page");
  });
});
