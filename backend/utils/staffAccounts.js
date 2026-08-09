// backend/utils/staffAccounts.js
//
// Store + helpers for super-admin-provisioned STAFF accounts (branch chat
// dashboard users) authenticated by password + emailed OTP.
//
// DESIGN — ZERO REGRESSION:
//   These accounts live in their OWN Firestore collection (`staffAccounts`) and
//   are NOT Firebase Auth users. They never produce a Firebase ID token, so they
//   cannot use (or bypass) the existing Firebase / issue-fallback-token flow.
//   The staff-auth routes mint the SAME `branchadmin` HMAC token the dashboard
//   already understands, so downstream authorization is unchanged.
//
// Passwords are hashed with scrypt (Node built-in KDF — no extra dependency)
// using a random per-user salt; only the derived hash is stored.

const crypto = require("crypto");
const { db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore"); // v14: namespace API removed

const COLLECTION = "staffAccounts";

// scrypt cost params. 128*N*r bytes ≈ 16 MB at N=16384,r=8 (< default maxmem).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// Account lockout after too many failed PASSWORD attempts (OTP has its own
// throttle in staffOtp.js). Tunable via env.
const MAX_FAILED_LOGINS = Number(process.env.STAFF_MAX_FAILED_LOGINS || 8);
const LOCKOUT_MINUTES = Number(process.env.STAFF_LOCKOUT_MINUTES || 15);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** Hash a plaintext password → "scrypt$N$r$p$saltB64$hashB64" (async, non-blocking). */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(
      String(password),
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (err, derived) => {
        if (err) return reject(err);
        resolve(
          `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${derived.toString("base64")}`
        );
      }
    );
  });
}

/** Constant-time verify of a plaintext password against a stored scrypt string. */
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    try {
      const parts = String(stored).split("$");
      if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
      const [, N, r, p, saltB64, hashB64] = parts;
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(hashB64, "base64");
      crypto.scrypt(
        String(password),
        salt,
        expected.length,
        { N: Number(N), r: Number(r), p: Number(p) },
        (err, actual) => {
          if (err) return resolve(false);
          resolve(
            actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
          );
        }
      );
    } catch {
      resolve(false);
    }
  });
}

/** Strip secret fields before returning a staff record to any caller. */
function publicView(id, data) {
  if (!data) return null;
  const { passwordHash, ...rest } = data;
  return { id, ...rest, hasPassword: Boolean(passwordHash) };
}

/** Find an active-or-disabled staff record by email. Returns raw doc {id,...data} or null. */
async function findByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const snap = await db.collection(COLLECTION).where("email", "==", e).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getById(id) {
  const doc = await db.collection(COLLECTION).doc(String(id)).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Find a staff record bound to a branch. One staff account per branch is the
 * rule, so this powers the create/reassign uniqueness checks. Pass `excludeId`
 * to ignore the record being updated. Returns raw doc {id,...data} or null.
 */
async function findByBranchId(branchId, { excludeId } = {}) {
  if (!branchId) return null;
  const snap = await db
    .collection(COLLECTION)
    .where("branchId", "==", String(branchId))
    .limit(2)
    .get();
  if (snap.empty) return null;
  for (const doc of snap.docs) {
    if (excludeId && doc.id === String(excludeId)) continue;
    return { id: doc.id, ...doc.data() };
  }
  return null;
}

/**
 * Create a staff account. Throws { code:'EMAIL_EXISTS' } if the email is taken.
 * @returns {Promise<{id:string}>}
 */
async function createStaff({
  email,
  password,
  branchId,
  branchName,
  branchEmail,
  displayName,
  createdBy,
  twoFactorEnabled = true,
}) {
  const e = normalizeEmail(email);
  if (!e) throw Object.assign(new Error("email is required"), { code: "BAD_INPUT" });
  if (!password) throw Object.assign(new Error("password is required"), { code: "BAD_INPUT" });
  if (!branchId || !branchName) {
    throw Object.assign(new Error("branchId and branchName are required"), { code: "BAD_INPUT" });
  }
  // branchEmail is the branch's chat identity (room + message routing); it must
  // be present and is NEVER allowed to fall back to the staffer's personal email.
  if (!normalizeEmail(branchEmail)) {
    throw Object.assign(new Error("branchEmail is required"), { code: "BAD_INPUT" });
  }

  const existing = await findByEmail(e);
  if (existing) throw Object.assign(new Error("email already exists"), { code: "EMAIL_EXISTS" });

  // One staff account per branch.
  const branchTaken = await findByBranchId(branchId);
  if (branchTaken) {
    throw Object.assign(new Error("branch already has a staff account"), { code: "BRANCH_EXISTS" });
  }

  const passwordHash = await hashPassword(password);
  const ref = db.collection(COLLECTION).doc();
  await ref.set({
    email: e,
    displayName: displayName || null,
    passwordHash,
    role: "branchadmin",
    branchId,
    branchName,
    branchEmail: normalizeEmail(branchEmail),
    status: "active",
    twoFactorEnabled: Boolean(twoFactorEnabled),
    twoFactorMethod: "email_otp",
    mustChangePassword: true,
    failedLoginCount: 0,
    lockedUntil: null,
    createdBy: createdBy || null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastLoginAt: null,
  });
  return { id: ref.id };
}

async function updateStaff(id, patch = {}) {
  const ref = db.collection(COLLECTION).doc(String(id));
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  return getById(id);
}

/** Set a new password (also flips mustChangePassword + clears any lockout). */
async function setPassword(id, password, { mustChangePassword = true } = {}) {
  const passwordHash = await hashPassword(password);
  return updateStaff(id, {
    passwordHash,
    mustChangePassword: Boolean(mustChangePassword),
    failedLoginCount: 0,
    lockedUntil: null,
  });
}

async function listStaff() {
  const snap = await db.collection(COLLECTION).orderBy("email").get();
  return snap.docs.map((d) => publicView(d.id, d.data()));
}

async function deleteStaff(id) {
  await db.collection(COLLECTION).doc(String(id)).delete();
}

// ── Lockout helpers ─────────────────────────────────────────────────────────
function isLocked(staff) {
  if (!staff || !staff.lockedUntil) return false;
  const until = new Date(staff.lockedUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

async function recordFailedLogin(id, current) {
  const count = (current?.failedLoginCount || 0) + 1;
  const patch = { failedLoginCount: count };
  if (count >= MAX_FAILED_LOGINS) {
    patch.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
    patch.failedLoginCount = 0; // reset counter for the next window
  }
  await updateStaff(id, patch);
  return patch.lockedUntil || null;
}

async function recordSuccessfulLogin(id) {
  await updateStaff(id, {
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: new Date().toISOString(),
  });
}

module.exports = {
  COLLECTION,
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  publicView,
  findByEmail,
  getById,
  findByBranchId,
  createStaff,
  updateStaff,
  setPassword,
  listStaff,
  deleteStaff,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
};
