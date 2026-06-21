// backend/utils/staffOtp.js
//
// Hardened email-OTP second factor for staff accounts.
//
// Security properties:
//   - 6-digit codes via crypto.randomInt (CSPRNG), zero-padded.
//   - Only an HMAC-SHA256 hash of the code is stored (peppered with a server
//     secret) so a Firestore read alone cannot reveal/brute-force the code.
//   - Single-use: the record is deleted on the first successful verification.
//   - Short TTL (default 10 min), capped verify attempts, and send throttling
//     (min interval + max sends per rolling window).
//   - Codes are never logged.
//
// Storage: collection `staff_otps`, one active doc per email (doc id = email).

const crypto = require("crypto");
const { db, admin } = require("./firebase");

const COLLECTION = "staff_otps";

const TTL_SEC = Number(process.env.STAFF_OTP_TTL_SEC || 600); // 10 min
const MAX_ATTEMPTS = Number(process.env.STAFF_OTP_MAX_ATTEMPTS || 5);
const RESEND_MIN_INTERVAL_SEC = Number(process.env.STAFF_OTP_RESEND_INTERVAL_SEC || 45);
const MAX_SENDS_PER_WINDOW = Number(process.env.STAFF_OTP_MAX_SENDS || 5);
const SEND_WINDOW_SEC = Number(process.env.STAFF_OTP_SEND_WINDOW_SEC || 900); // 15 min

function pepper() {
  return (
    process.env.STAFF_OTP_PEPPER ||
    process.env.JWT_SECRET ||
    "magis-otp-dev-pepper-change-me"
  );
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateCode() {
  // 0–999999, zero-padded to 6 digits.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code, email) {
  // Bind the hash to the email so a code can't be replayed across accounts.
  return crypto
    .createHmac("sha256", pepper())
    .update(`${normalizeEmail(email)}:${String(code)}`)
    .digest("hex");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create/refresh an OTP for `email`, enforcing throttle. Returns the plaintext
 * code (for the caller to email) plus timing metadata, or a throttle signal.
 *
 * @returns {Promise<{ ok:true, code:string, expiresAt:string, ttlSec:number }
 *   | { ok:false, code:'THROTTLED', retryAfterSec:number }>}
 */
async function requestOtp({ email, sessionId, ip, userAgent }) {
  const e = normalizeEmail(email);
  const ref = db.collection(COLLECTION).doc(e);
  const snap = await ref.get();
  const now = nowSec();

  let sends = [];
  if (snap.exists) {
    const d = snap.data();
    const last = d.lastSentAt || 0;
    if (now - last < RESEND_MIN_INTERVAL_SEC) {
      return { ok: false, code: "THROTTLED", retryAfterSec: RESEND_MIN_INTERVAL_SEC - (now - last) };
    }
    // Keep only sends within the rolling window.
    sends = (Array.isArray(d.sends) ? d.sends : []).filter((t) => now - t < SEND_WINDOW_SEC);
    if (sends.length >= MAX_SENDS_PER_WINDOW) {
      const oldest = sends[0];
      return { ok: false, code: "THROTTLED", retryAfterSec: SEND_WINDOW_SEC - (now - oldest) };
    }
  }

  const code = generateCode();
  const expiresAtSec = now + TTL_SEC;
  sends.push(now);

  await ref.set({
    email: e,
    codeHash: hashCode(code, e),
    expiresAt: new Date(expiresAtSec * 1000).toISOString(),
    attempts: 0,
    lastSentAt: now,
    sends,
    sessionId: sessionId || null,
    ip: ip || null,
    userAgent: userAgent || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    code,
    expiresAt: new Date(expiresAtSec * 1000).toISOString(),
    ttlSec: TTL_SEC,
  };
}

/**
 * Verify a submitted code. Single-use on success.
 * @returns {Promise<{ ok:true } | { ok:false, code:'NO_CODE'|'EXPIRED'|'TOO_MANY_ATTEMPTS'|'INVALID', attemptsLeft?:number }>}
 */
async function verifyOtp({ email, code }) {
  const e = normalizeEmail(email);
  const ref = db.collection(COLLECTION).doc(e);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NO_CODE" };

  const d = snap.data();

  if (new Date(d.expiresAt).getTime() <= Date.now()) {
    await ref.delete().catch(() => {});
    return { ok: false, code: "EXPIRED" };
  }
  if ((d.attempts || 0) >= MAX_ATTEMPTS) {
    await ref.delete().catch(() => {});
    return { ok: false, code: "TOO_MANY_ATTEMPTS" };
  }

  const submitted = hashCode(String(code || "").trim(), e);
  const expected = String(d.codeHash || "");
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    const attempts = (d.attempts || 0) + 1;
    await ref.update({ attempts });
    return { ok: false, code: "INVALID", attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) };
  }

  // Success — single-use.
  await ref.delete().catch(() => {});
  return { ok: true };
}

/** Best-effort clear (e.g., on logout). Never throws. */
async function clearOtp(email) {
  try {
    await db.collection(COLLECTION).doc(normalizeEmail(email)).delete();
  } catch {
    /* ignore */
  }
}

module.exports = {
  COLLECTION,
  TTL_SEC,
  MAX_ATTEMPTS,
  RESEND_MIN_INTERVAL_SEC,
  MAX_SENDS_PER_WINDOW,
  requestOtp,
  verifyOtp,
  clearOtp,
};
