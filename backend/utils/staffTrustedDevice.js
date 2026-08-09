// backend/utils/staffTrustedDevice.js
//
// "Remember this device" support for staff email-OTP login (maximum convenience).
//
// After a successful OTP login a staffer may opt to TRUST the current computer.
// We mint an opaque token `${docId}.${secret}` and store only an HMAC of the
// secret in Firestore (`staff_trusted_devices`). The client keeps the token
// (localStorage) and replays it on future logins; if it is still valid the
// backend SKIPS the emailed code (the password remains required as factor 1, and
// possession of the trusted token is factor 2).
//
// Transport is the token itself (sent in the request body), not a SameSite
// cookie — this matches how the app already carries `branchAdminToken` and works
// reliably cross-origin and inside the Electron shell.
//
// Revocation: an admin disabling, resetting, toggling 2FA, deleting, or
// explicitly revoking a staffer deletes their device docs, so stale client
// tokens simply fail verification and fall back to the emailed code.

const crypto = require("crypto");
const { db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore"); // v14: namespace API removed

const COLLECTION = "staff_trusted_devices";
const TRUST_DAYS = Number(process.env.STAFF_TRUSTED_DEVICE_DAYS || 30);

function pepper() {
  return (
    process.env.STAFF_OTP_PEPPER ||
    process.env.JWT_SECRET ||
    "magis-otp-dev-pepper-change-me"
  );
}

function hashSecret(secret) {
  return crypto.createHmac("sha256", pepper()).update(String(secret)).digest("hex");
}

/**
 * Create a trusted-device record for a staffer and return the opaque token the
 * client must store and replay.
 * @returns {Promise<{ token:string, expiresAt:string, days:number }>}
 */
async function createTrustedDevice({ staffId, email, userAgent }) {
  const ref = db.collection(COLLECTION).doc();
  const secret = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await ref.set({
    staffId,
    email: String(email || "").toLowerCase(),
    secretHash: hashSecret(secret),
    expiresAt,
    userAgent: userAgent || null,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: new Date().toISOString(),
  });
  return { token: `${ref.id}.${secret}`, expiresAt, days: TRUST_DAYS };
}

/**
 * Verify a replayed trusted-device token belongs to `staffId` and is unexpired.
 * Best-effort: never throws (returns false on any problem).
 */
async function verifyTrustedDevice({ token, staffId }) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const docId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!docId || !secret) return false;

  try {
    const ref = db.collection(COLLECTION).doc(docId);
    const doc = await ref.get();
    if (!doc.exists) return false;
    const d = doc.data();
    if (d.staffId !== staffId) return false;
    if (new Date(d.expiresAt).getTime() <= Date.now()) {
      await ref.delete().catch(() => {});
      return false;
    }
    const expected = Buffer.from(String(d.secretHash || ""));
    const actual = Buffer.from(hashSecret(secret));
    const ok = expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
    if (ok) ref.update({ lastUsedAt: new Date().toISOString() }).catch(() => {});
    return ok;
  } catch (e) {
    console.warn("[STAFF] verifyTrustedDevice failed:", e.message);
    return false;
  }
}

/** Delete every trusted device for a staffer. Returns the count removed. */
async function revokeAllForStaff(staffId) {
  try {
    const snap = await db.collection(COLLECTION).where("staffId", "==", staffId).get();
    if (snap.empty) return 0;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return snap.size;
  } catch (e) {
    console.warn("[STAFF] revokeAllForStaff failed:", e.message);
    return 0;
  }
}

module.exports = {
  COLLECTION,
  TRUST_DAYS,
  createTrustedDevice,
  verifyTrustedDevice,
  revokeAllForStaff,
};
