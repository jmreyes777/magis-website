// backend/routes/webauthn.js
//
// Passkeys / WebAuthn for branch-admin sign-in (megaplan Phase 5).
//
// Phishing-resistant, possession+biometric login for staff. ADDITIVE by
// design: the existing password+OTP and Firebase+TOTP flows are untouched,
// and a passkey login mints EXACTLY the same session artifacts as the OTP
// path (HMAC branchadmin token, cookie, mfa_sessions doc, Firebase custom
// token), so everything downstream behaves identically.
//
// Endpoints:
//   POST /api/webauthn/register-options   (auth: branchadmin + MFA session)
//   POST /api/webauthn/register-verify    (auth: branchadmin + MFA session)
//   POST /api/webauthn/login-options      (public, rate-limited in server.js)
//   POST /api/webauthn/login-verify       (public, rate-limited in server.js)
//   GET  /api/webauthn/credentials        (auth) — list own passkeys
//   POST /api/webauthn/credentials/revoke (auth + MFA) — disable one
//
// Config (backend.env.example):
//   PASSKEYS_ENABLED   default "true" (kill switch)
//   WEBAUTHN_RP_ID     e.g. "magis-admin-staging.onrender.com" (no scheme!)
//   WEBAUTHN_ORIGINS   CSV of allowed web origins for assertions
//   WEBAUTHN_RP_NAME   display name shown by authenticators
//
// Challenges are single-use Firestore docs (webauthnChallenges) with a 5-min
// TTL — cluster-safe without relying on Redis. Credentials live in
// webauthnCredentials keyed by the base64url credential id (client Firestore
// access is denied by default in firestore.rules; only the Admin SDK reads).

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const { db } = require("../utils/firebase");
const { signJWT } = require("../utils/secretPool");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const { requireMFA } = require("../middlewares/requireMFA");
const { recordAuditEvent, auditContextFromReq, ACTIONS } = require("../utils/auditLog");
const {
  setBranchAdminCookie,
  writeMfaSession,
  mintFirebaseToken,
  sessionIdFrom,
} = require("./branchAuth");

const ENABLED = String(process.env.PASSKEYS_ENABLED || "true") !== "false";
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Magis Admin";
// rpID must equal the site's effective domain (NO scheme/port). Default to the
// staging admin host; production cutover overrides via env.
const RP_ID = process.env.WEBAUTHN_RP_ID || "magis-admin-staging.onrender.com";
const ORIGINS = (process.env.WEBAUTHN_ORIGINS ||
  "https://magis-admin-staging.onrender.com,http://localhost:3001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FALLBACK_TTL_MIN = Number(
  process.env.JWT_FALLBACK_TTL_MIN || process.env.JWT_ADMIN_TTL_MIN || "240"
);
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CREDS = () => db.collection("webauthnCredentials");
const CHALLENGES = () => db.collection("webauthnChallenges");

function disabledGuard(_req, res, next) {
  if (!ENABLED) return res.status(404).json({ error: "Passkeys are not enabled." });
  next();
}
router.use(disabledGuard);

// ── Challenge store (single-use, TTL) ────────────────────────────────────────
async function saveChallenge(purpose, challenge, extra = {}) {
  const id = crypto.randomUUID();
  await CHALLENGES().doc(id).set({
    purpose,
    challenge,
    ...extra,
    expireAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    createdAt: new Date().toISOString(),
  });
  return id;
}

async function consumeChallenge(id, purpose) {
  if (!id || typeof id !== "string") return null;
  const ref = CHALLENGES().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.delete(); // single-use, even if it turns out invalid below
  const data = snap.data();
  if (data.purpose !== purpose) return null;
  if (new Date(data.expireAt.toDate ? data.expireAt.toDate() : data.expireAt) < new Date()) return null;
  return data;
}

async function credentialsForEmail(email) {
  const snap = await CREDS().where("email", "==", email).where("disabled", "==", false).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── Enrollment (existing authenticated admin adds a passkey) ─────────────────
router.post("/register-options", authenticateBranchAdmin, requireMFA, async (req, res) => {
  try {
    const email = (req.branchEmail || req.user.email || "").toLowerCase();
    if (!email) return res.status(400).json({ error: "No account email on session." });

    const existing = await credentialsForEmail(email);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: email,
      userDisplayName: req.user.branchName || email,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: c.transports || undefined,
      })),
      authenticatorSelection: {
        residentKey: "preferred", // discoverable → usernameless sign-in
        userVerification: "preferred",
      },
    });

    const challengeId = await saveChallenge("register", options.challenge, {
      email,
      uid: req.user.uid || null,
      branchId: req.user.branchId || null,
      branchName: req.user.branchName || null,
    });
    return res.json({ challengeId, options });
  } catch (e) {
    console.error("[WEBAUTHN:register-options]", e.message);
    return res.status(500).json({ error: "Could not start passkey enrollment." });
  }
});

router.post("/register-verify", authenticateBranchAdmin, requireMFA, async (req, res) => {
  try {
    const email = (req.branchEmail || req.user.email || "").toLowerCase();
    const { challengeId, attestation, deviceName } = req.body || {};
    const ch = await consumeChallenge(challengeId, "register");
    if (!ch || ch.email !== email) {
      return res.status(400).json({ error: "Enrollment challenge expired — try again." });
    }

    const verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: ch.challenge,
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Passkey could not be verified." });
    }

    const { credential } = verification.registrationInfo;
    await CREDS().doc(credential.id).set({
      email,
      uid: ch.uid || req.user.uid || null,
      branchId: ch.branchId || req.user.branchId || null,
      branchName: ch.branchName || req.user.branchName || null,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter || 0,
      transports: attestation?.response?.transports || [],
      deviceType: verification.registrationInfo.credentialDeviceType || null,
      backedUp: Boolean(verification.registrationInfo.credentialBackedUp),
      deviceName: String(deviceName || "Passkey").slice(0, 64),
      disabled: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });

    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_TRUSTED_DEVICE_ADDED,
      severity: "notice",
      actor: { type: "branchadmin", email, branchEmail: email },
      branchEmail: email,
      context: auditContextFromReq(req),
      meta: { method: "webauthn_register", deviceName: deviceName || "Passkey" },
    });
    return res.json({ ok: true, id: credential.id });
  } catch (e) {
    console.error("[WEBAUTHN:register-verify]", e.message);
    return res.status(500).json({ error: "Passkey enrollment failed." });
  }
});

// ── Sign-in ──────────────────────────────────────────────────────────────────
router.post("/login-options", express.json(), async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    // With discoverable credentials the email is optional (usernameless flow).
    let allowCredentials;
    if (email) {
      const creds = await credentialsForEmail(email);
      if (creds.length === 0) {
        // Anti-enumeration: identical response shape whether or not the
        // account exists / has passkeys — the browser will simply find no
        // matching credential and the user falls back to password login.
        allowCredentials = undefined;
      } else {
        allowCredentials = creds.map((c) => ({ id: c.id, transports: c.transports || undefined }));
      }
    }
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "preferred",
      allowCredentials,
    });
    const challengeId = await saveChallenge("login", options.challenge, {});
    return res.json({ challengeId, options });
  } catch (e) {
    console.error("[WEBAUTHN:login-options]", e.message);
    return res.status(500).json({ error: "Could not start passkey sign-in." });
  }
});

router.post("/login-verify", express.json(), async (req, res) => {
  const fail = (status, msg, email) => {
    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_LOGIN_FAILURE,
      severity: "warning",
      outcome: "failure",
      actor: { type: "branchadmin", email: email || null },
      context: auditContextFromReq(req),
      meta: { method: "webauthn", route: "/api/webauthn/login-verify" },
    });
    return res.status(status).json({ error: msg });
  };

  try {
    const { challengeId, assertion } = req.body || {};
    if (!assertion?.id) return fail(400, "Missing passkey assertion.");

    const ch = await consumeChallenge(challengeId, "login");
    if (!ch) return fail(400, "Sign-in challenge expired — try again.");

    const credSnap = await CREDS().doc(String(assertion.id)).get();
    if (!credSnap.exists || credSnap.data().disabled) {
      return fail(401, "Unknown passkey. Sign in with your password instead.");
    }
    const cred = credSnap.data();

    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: ch.challenge,
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: {
        id: credSnap.id,
        publicKey: Buffer.from(cred.publicKey, "base64url"),
        counter: cred.counter || 0,
        transports: cred.transports || undefined,
      },
    });
    if (!verification.verified) return fail(401, "Passkey verification failed.", cred.email);

    // Clone detection: a signature counter that does not advance past a
    // previously-seen non-zero value indicates a copied authenticator.
    const newCounter = verification.authenticationInfo?.newCounter ?? 0;
    if ((cred.counter || 0) > 0 && newCounter > 0 && newCounter <= cred.counter) {
      console.warn(`[WEBAUTHN] counter regression for ${cred.email} (${cred.counter} -> ${newCounter})`);
      return fail(401, "Passkey rejected (possible clone). Contact your administrator.", cred.email);
    }
    await credSnap.ref.update({ counter: newCounter, lastUsedAt: new Date().toISOString() });

    // Mint the SAME session artifacts as the OTP login path.
    const account = {
      id: cred.uid || credSnap.id,
      branchId: cred.branchId,
      email: cred.email,
      branchName: cred.branchName || "Branch Admin",
    };
    const token = await signJWT(
      {
        uid: account.id,
        branchId: account.branchId,
        email: account.email,
        branchName: account.branchName,
        role: "branchadmin",
        fallback: true,
        authVia: "webauthn",
      },
      { expiresIn: `${FALLBACK_TTL_MIN}m` }
    );
    setBranchAdminCookie(res, token);
    await writeMfaSession(req, account.email, sessionIdFrom(req, account), "webauthn");
    const firebaseToken = await mintFirebaseToken(account);

    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_LOGIN_SUCCESS,
      severity: "notice",
      actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
      branchEmail: account.email,
      context: auditContextFromReq(req),
      meta: { method: "webauthn", deviceName: cred.deviceName || null },
    });

    return res.json({ token, firebaseToken, branchName: account.branchName });
  } catch (e) {
    console.error("[WEBAUTHN:login-verify]", e.message);
    return fail(500, "Passkey sign-in failed. Please use your password.");
  }
});

// ── Self-service management ──────────────────────────────────────────────────
router.get("/credentials", authenticateBranchAdmin, async (req, res) => {
  try {
    const email = (req.branchEmail || req.user.email || "").toLowerCase();
    const creds = await credentialsForEmail(email);
    return res.json(
      creds.map((c) => ({
        id: c.id,
        deviceName: c.deviceName,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        backedUp: c.backedUp,
      }))
    );
  } catch (e) {
    console.error("[WEBAUTHN:credentials]", e.message);
    return res.status(500).json({ error: "Could not list passkeys." });
  }
});

router.post("/credentials/revoke", authenticateBranchAdmin, requireMFA, async (req, res) => {
  try {
    const email = (req.branchEmail || req.user.email || "").toLowerCase();
    const id = String(req.body?.id || "");
    const snap = await CREDS().doc(id).get();
    if (!snap.exists || snap.data().email !== email) {
      return res.status(404).json({ error: "Passkey not found." });
    }
    await snap.ref.update({ disabled: true, disabledAt: new Date().toISOString() });
    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_TRUSTED_DEVICE_REVOKED,
      severity: "notice",
      actor: { type: "branchadmin", email, branchEmail: email },
      branchEmail: email,
      context: auditContextFromReq(req),
      meta: { method: "webauthn_revoke", deviceName: snap.data().deviceName || null },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[WEBAUTHN:revoke]", e.message);
    return res.status(500).json({ error: "Could not revoke passkey." });
  }
});

module.exports = router;
