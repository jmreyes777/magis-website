// TST2 (testing megaplan): TOTP + backup-code + secret-encryption contracts.
// Pure crypto — no Firebase, no Redis, no env. The RFC 6238 vectors pin our
// implementation to the standard Google Authenticator implements.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  generateSecret,
  generateTOTPURI,
  generateBackupCodes,
  verifyTOTP,
  generateTOTP,
  hashBackupCode,
  verifyBackupCode,
  encryptSecret,
  decryptSecret,
  TOTP_CONFIG,
} = require("../utils/mfa");

// RFC 6238 Appendix B test secret: ASCII "12345678901234567890" in base32.
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

describe("RFC 6238 vectors (SHA-1, 30s step, last 6 of the 8-digit vectors)", () => {
  test("T=59s → 287082", () => {
    Date.now = () => 59_000;
    assert.equal(generateTOTP(RFC_SECRET_B32, 0), "287082");
  });
  test("T=1111111109s → 081804 (leading-zero padding matters)", () => {
    Date.now = () => 1_111_111_109_000;
    assert.equal(generateTOTP(RFC_SECRET_B32, 0), "081804");
  });
});

describe("verifyTOTP drift window (config window = ±1 step)", () => {
  test("accepts current, previous and next step; rejects ±2 steps and garbage", () => {
    Date.now = () => 1_752_800_000_000; // fixed → fully deterministic
    const step = TOTP_CONFIG.step;
    assert.equal(verifyTOTP(RFC_SECRET_B32, generateTOTP(RFC_SECRET_B32, 0)), true);
    assert.equal(verifyTOTP(RFC_SECRET_B32, generateTOTP(RFC_SECRET_B32, -step)), true);
    assert.equal(verifyTOTP(RFC_SECRET_B32, generateTOTP(RFC_SECRET_B32, +step)), true);
    assert.equal(verifyTOTP(RFC_SECRET_B32, generateTOTP(RFC_SECRET_B32, -2 * step)), false);
    assert.equal(verifyTOTP(RFC_SECRET_B32, generateTOTP(RFC_SECRET_B32, +2 * step)), false);
    assert.equal(verifyTOTP(RFC_SECRET_B32, "000000") || verifyTOTP(RFC_SECRET_B32, "abc"), false);
  });
  test("wrong secret never verifies", () => {
    Date.now = () => 1_752_800_000_000;
    const other = generateSecret();
    assert.equal(verifyTOTP(other, generateTOTP(RFC_SECRET_B32, 0)), false);
  });
});

describe("secrets & URIs", () => {
  test("generateSecret: 20 random bytes → 32 base32 chars, valid alphabet", () => {
    const s = generateSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
  });
  test("TOTP URI embeds secret, issuer, and account", () => {
    const uri = generateTOTPURI("ABC234", "staff@magis.ph");
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.ok(uri.includes("secret=ABC234"));
    assert.ok(uri.includes(encodeURIComponent("staff@magis.ph")));
  });
});

describe("backup codes", () => {
  test("generates 10 single-use codes, 16 uppercase hex chars (64-bit entropy)", () => {
    const codes = generateBackupCodes();
    assert.equal(codes.length, 10);
    for (const c of codes) assert.match(c, /^[0-9A-F]{16}$/);
  });
  test("verification is hash-membership; separators/case are normalized", () => {
    const [code] = generateBackupCodes(1);
    const stored = [hashBackupCode(code), hashBackupCode("FFFF000011112222")];
    assert.equal(verifyBackupCode(code, stored), true);
    const spaced = code.toLowerCase().replace(/(.{4})/g, "$1-").replace(/-$/, "");
    assert.equal(verifyBackupCode(spaced, stored), true); // "abcd-ef01-…" style entry
    assert.equal(verifyBackupCode("0000000000000000", stored), false);
    assert.equal(verifyBackupCode(code, []), false);
    assert.equal(verifyBackupCode(code, undefined), false);
  });
});

describe("secret encryption at rest (AES-256-GCM)", () => {
  const key = crypto.randomBytes(32).toString("hex");
  test("encrypt → decrypt round-trips; ciphertext differs per call (fresh IV)", () => {
    const enc1 = encryptSecret(RFC_SECRET_B32, key);
    const enc2 = encryptSecret(RFC_SECRET_B32, key);
    assert.equal(decryptSecret(enc1, key), RFC_SECRET_B32);
    assert.equal(decryptSecret(enc2, key), RFC_SECRET_B32);
    assert.notEqual(enc1.encrypted + enc1.iv, enc2.encrypted + enc2.iv);
  });
  test("tampered authTag or wrong key throws (GCM integrity)", () => {
    const enc = encryptSecret(RFC_SECRET_B32, key);
    const tampered = { ...enc, authTag: enc.authTag.replace(/^../, enc.authTag.startsWith("00") ? "11" : "00") };
    assert.throws(() => decryptSecret(tampered, key));
    const wrongKey = crypto.randomBytes(32).toString("hex");
    assert.throws(() => decryptSecret(enc, wrongKey));
  });
});
