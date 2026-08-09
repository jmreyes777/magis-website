// backend/utils/branchAccounts.js
//
// Credential layer for BRANCH logins, backed by the existing `branchAdmins`
// Firestore collection (where each branch's email lives). This restores the
// simple model the team wanted: ONE login per branch (email + password) with an
// emailed OTP on every sign-in.
//
// DESIGN:
//   - The login email IS the branch email (chat routing identity), so the doc's
//     `email` field doubles as the credential id and the room key.
//   - Passwords are hashed with scrypt (Node built-in KDF — no extra dependency)
//     using a random per-user salt; only the derived hash is stored. The legacy
//     plaintext/bcrypt `password` field is NOT used or read.
//   - The super-admin "set password" flow (upsertCredentials) is the source of
//     truth for the fields login needs (email, branchId, branchName,
//     passwordHash), so we never depend on the legacy doc shape.
//
// This module is self-contained (no dependency on the staff modules) so the old
// staff system can be retired without affecting branch auth.

const crypto = require("crypto");
const { db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore"); // v14: namespace API removed

const COLLECTION = "branchAdmins";
const BRANCHES_COLLECTION = "branches";

// scrypt cost params (same as the retired staff module): ~16 MB at N=16384,r=8.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// Lockout after too many failed PASSWORD attempts (OTP has its own throttle).
const MAX_FAILED_LOGINS = Number(process.env.BRANCH_MAX_FAILED_LOGINS || 8);
const LOCKOUT_MINUTES = Number(process.env.BRANCH_LOCKOUT_MINUTES || 15);

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

/** Strip secret fields before returning a record to any caller. */
function publicView(id, data) {
  if (!data) return null;
  const { password, passwordHash, ...rest } = data;
  return { id, ...rest, hasPassword: Boolean(passwordHash) };
}

/** Find a branch-admin credential record by (login) email. Returns {id,...data} or null. */
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

async function findByBranchId(branchId) {
  if (!branchId) return null;
  const snap = await db
    .collection(COLLECTION)
    .where("branchId", "==", String(branchId))
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

/** Best-effort branch display name from the `branches` collection. */
async function getBranchName(branchId) {
  if (!branchId) return null;
  try {
    const doc = await db.collection(BRANCHES_COLLECTION).doc(String(branchId)).get();
    if (doc.exists) {
      const d = doc.data() || {};
      return d.name || d.branchName || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Super-admin: set/predefine a branch's login password. This is the source of
 * truth for the fields login needs, so it (re)writes them via a MERGE that
 * preserves any other existing fields on the doc (MFA state, etc.).
 *
 * Looks up the credential doc by email first (so existing branch admins keep
 * their doc id + Firebase linkage); falls back to branchId; creates one if none
 * exists yet. Returns { id }.
 */
async function upsertCredentials({
  email,
  branchId,
  branchName,
  password,
  mustChangePassword = true,
  passwordSetBy = null,
}) {
  const e = normalizeEmail(email);
  if (!e) throw Object.assign(new Error("email is required"), { code: "BAD_INPUT" });
  if (!branchId) throw Object.assign(new Error("branchId is required"), { code: "BAD_INPUT" });
  if (!password) throw Object.assign(new Error("password is required"), { code: "BAD_INPUT" });

  const existing = (await findByEmail(e)) || (await findByBranchId(branchId));
  const ref = existing
    ? db.collection(COLLECTION).doc(existing.id)
    : db.collection(COLLECTION).doc();

  const resolvedName =
    branchName || (existing && existing.branchName) || (await getBranchName(branchId)) || "Branch Admin";

  const passwordHash = await hashPassword(password);
  const now = FieldValue.serverTimestamp();

  await ref.set(
    {
      email: e,
      branchId: String(branchId),
      branchName: resolvedName,
      role: "branchadmin",
      passwordHash,
      twoFactorMethod: "email_otp",
      mustChangePassword: Boolean(mustChangePassword),
      failedLoginCount: 0,
      lockedUntil: null,
      passwordSetBy: passwordSetBy || null,
      passwordSetAt: new Date().toISOString(),
      updatedAt: now,
      ...(existing ? {} : { createdAt: now }),
    },
    { merge: true }
  );

  return { id: ref.id };
}

async function update(id, patch = {}) {
  const ref = db.collection(COLLECTION).doc(String(id));
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  return getById(id);
}

/** Set a new password (used by self change + forgot-password reset). */
async function setPassword(id, password, { mustChangePassword = false } = {}) {
  const passwordHash = await hashPassword(password);
  return update(id, {
    passwordHash,
    mustChangePassword: Boolean(mustChangePassword),
    failedLoginCount: 0,
    lockedUntil: null,
    passwordSetAt: new Date().toISOString(),
  });
}

/** List branch-admin credential records (secrets stripped) for the super-admin UI. */
async function listBranchAdmins() {
  const snap = await db.collection(COLLECTION).get();
  return snap.docs
    .map((d) => publicView(d.id, d.data()))
    .sort((a, b) => String(a.email).localeCompare(String(b.email)));
}

// ── Lockout helpers ─────────────────────────────────────────────────────────
function isLocked(account) {
  if (!account || !account.lockedUntil) return false;
  const until = new Date(account.lockedUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

async function recordFailedLogin(id, current) {
  const count = (current?.failedLoginCount || 0) + 1;
  const patch = { failedLoginCount: count };
  if (count >= MAX_FAILED_LOGINS) {
    patch.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
    patch.failedLoginCount = 0; // reset counter for the next window
  }
  await update(id, patch);
  return patch.lockedUntil || null;
}

async function recordSuccessfulLogin(id) {
  await update(id, {
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
  getBranchName,
  upsertCredentials,
  update,
  setPassword,
  listBranchAdmins,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
};
