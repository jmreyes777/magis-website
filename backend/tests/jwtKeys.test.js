// TST2 (testing megaplan): the key policy that prevents algorithm-confusion —
// which key verifies which token, and the loud failure when signing keys are
// missing. HS256 posture; env set before require (module reads env at load).
process.env.JWT_SECRET = "tst2-jwtkeys-test-secret-fedcba9876543210";
process.env.JWT_ALG = "HS256";
delete process.env.JWT_PRIVATE_KEY;
delete process.env.JWT_PUBLIC_KEY;

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const keys = require("../utils/jwtKeys");

describe("getSigningParams (HS256 posture)", () => {
  test("signs with the shared secret", () => {
    const p = keys.getSigningParams();
    assert.equal(p.algorithm, "HS256");
    assert.equal(p.key, process.env.JWT_SECRET);
  });
});

describe("getVerifyParamsForToken — algorithm allow-list", () => {
  test("HS256 token → HMAC secret, algorithms pinned to HS256", () => {
    const token = jwt.sign({ x: 1 }, process.env.JWT_SECRET, { algorithm: "HS256" });
    const p = keys.getVerifyParamsForToken(token);
    assert.ok(p);
    assert.deepEqual(p.algorithms, ["HS256"]);
  });
  test("alg 'none' and garbage are unaccepted (null)", () => {
    // Hand-built unsigned token: {"alg":"none"} . payload . (empty sig)
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const noneToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ role: "superadmin" })}.`;
    assert.equal(keys.getVerifyParamsForToken(noneToken), null);
    assert.equal(keys.getVerifyParamsForToken("not-a-jwt"), null);
  });
  test("RS256 token is unaccepted when no public key is configured", () => {
    // Header claims RS256; without JWT_PUBLIC_KEY the policy must return null
    // (and NEVER fall back to using the HMAC secret — alg-confusion guard).
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const rsToken = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ role: "guest" })}.AAAA`;
    assert.equal(keys.getVerifyParamsForToken(rsToken), null);
  });
});

describe("verifyLocal", () => {
  test("round-trips a policy-conformant token", () => {
    const token = jwt.sign({ role: "guest" }, process.env.JWT_SECRET, {
      algorithm: "HS256",
      issuer: keys.JWT_ISSUER,
      audience: keys.audienceForRole("guest"),
      jwtid: "t-1",
      expiresIn: "5m",
    });
    const decoded = keys.verifyLocal(token);
    assert.equal(decoded.role, "guest");
    assert.equal(decoded.jti, "t-1");
  });
  test("throws on unaccepted algorithm instead of guessing a key", () => {
    assert.throws(() => keys.verifyLocal("not-a-jwt"), /unsupported|unaccepted/i);
  });
  test("throws on a token signed with the wrong secret", () => {
    const forged = jwt.sign({ role: "guest" }, "attacker", { algorithm: "HS256" });
    assert.throws(() => keys.verifyLocal(forged));
  });
});

describe("audience helpers", () => {
  test("every known role resolves to a non-empty audience; matching is reflexive", () => {
    for (const role of ["guest", "branchadmin", "superadmin", "staff"]) {
      const aud = keys.audienceForRole(role);
      assert.ok(typeof aud === "string" && aud.length > 0, `audienceForRole(${role})`);
      assert.equal(keys.audienceMatches(aud, aud), true);
    }
  });
});
