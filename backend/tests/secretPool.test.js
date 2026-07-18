// TST2 (testing megaplan): the JWT worker pool — sign/verify round-trip,
// tamper rejection, revocation (in-memory fallback path: no REDIS_URL here),
// and the expired-token contract that logout depends on. Env is configured
// BEFORE require because both the pool and its workers read it at startup;
// node:test runs each file in its own process, so this cannot leak elsewhere.
process.env.JWT_SECRET = "tst2-secret-pool-test-secret-0123456789abcdef";
process.env.JWT_WORKER_POOL = "1"; // one worker → deterministic, fast teardown
process.env.JWT_CLOCK_SKEW_SEC = "0"; // let 1ms-TTL tokens actually expire
delete process.env.REDIS_URL; // force the in-memory revocation fallback
delete process.env.JWT_PRIVATE_KEY; // HS256 posture regardless of local env
delete process.env.JWT_PUBLIC_KEY;
process.env.JWT_ALG = "HS256";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../utils/secretPool");

after(async () => {
  await pool.shutdown();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("sign → verify round-trip", () => {
  test("returns a 3-part token whose payload carries claims + auto-jti", async () => {
    const token = await pool.signJWT({ role: "guest", conversationId: "c1" }, { expiresIn: "5m" });
    assert.equal(typeof token, "string");
    assert.equal(token.split(".").length, 3);
    const payload = await pool.verifyJWT(token);
    assert.equal(payload.role, "guest");
    assert.equal(payload.conversationId, "c1");
    assert.ok(payload.jti, "worker must auto-assign a jti (revocation depends on it)");
    assert.ok(payload.exp > payload.iat);
  });
  test("guest/admin convenience signers apply their TTLs", async () => {
    const guest = await pool.verifyJWT(await pool.signGuestJWT({ role: "guest" }));
    const admin = await pool.verifyJWT(await pool.signAdminJWT({ role: "superadmin" }));
    const guestTtl = guest.exp - guest.iat;
    const adminTtl = admin.exp - admin.iat;
    assert.equal(guestTtl, Number(process.env.JWT_TTL_MIN || "30") * 60);
    assert.equal(adminTtl, Number(process.env.JWT_ADMIN_TTL_MIN || "240") * 60);
  });
});

describe("tamper rejection", () => {
  test("a modified signature never verifies", async () => {
    const token = await pool.signJWT({ role: "guest" }, { expiresIn: "5m" });
    const flip = (c) => (c === "A" ? "B" : "A");
    const tampered = token.slice(0, -1) + flip(token.slice(-1));
    await assert.rejects(pool.verifyJWT(tampered));
  });
  test("a token signed with a DIFFERENT secret never verifies", async () => {
    const jwt = require("jsonwebtoken");
    const forged = jwt.sign({ role: "superadmin", jti: "forged" }, "attacker-secret", {
      algorithm: "HS256",
      expiresIn: "5m",
    });
    await assert.rejects(pool.verifyJWT(forged));
  });
});

describe("revocation (logout/force-close path, memory fallback)", () => {
  test("a revoked jti is rejected by any later verify", async () => {
    const token = await pool.signJWT({ role: "guest" }, { expiresIn: "5m" });
    const { jti, exp } = await pool.verifyJWT(token);
    await pool.revokeJWT({ jti, expTimestamp: exp });
    await assert.rejects(pool.verifyJWT(token), /revoked/i);
  });
});

describe("expiry contract", () => {
  test("expired tokens reject via verifyJWT but resolve via verifyAllowExpired", async () => {
    const token = await pool.signJWT({ role: "guest" }, { expiresIn: "1ms" });
    await sleep(1100); // exp is second-granular — clear it decisively
    await assert.rejects(pool.verifyJWT(token), /expired/i);
    const payload = await pool.verifyAllowExpired(token);
    assert.equal(payload.role, "guest");
    assert.ok(payload.jti, "logout needs the jti of an expired token to revoke it");
  });
  test("verifyJWT strips caller attempts to ignore expiration (defense-in-depth)", async () => {
    const token = await pool.signJWT({ role: "guest" }, { expiresIn: "1ms" });
    await sleep(1100);
    await assert.rejects(pool.verifyJWT(token, { ignoreExpiration: true }), /expired/i);
  });
});
