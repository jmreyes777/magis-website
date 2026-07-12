// backend/routes/branchAuth.js
//
// SIMPLE branch login: email + password (checked against the `branchAdmins`
// collection) + an emailed 6-digit OTP on EVERY sign-in, delivered to that
// branch's predefined email.
//
// Flow:
//   POST /api/branch/login            { email, password }  -> always emails OTP
//   POST /api/branch/login/verify-otp { loginTicket, code } -> issues token
//   POST /api/branch/login/resend-otp { loginTicket }
//   POST /api/branch/change-password  (auth) { currentPassword, newPassword }
//   POST /api/branch/forgot           { email }            -> emails reset code
//   POST /api/branch/reset            { email, code, newPassword }
//
// On success it mints the SAME `branchadmin` HMAC token + cookie + `mfa_sessions`
// doc the dashboard already understands, so nothing downstream changes.

const express = require("express");
const router = express.Router();

const { db, admin } = require("../utils/firebase");
const { signJWT, verifyJWT } = require("../utils/secretPool");
const { getClientGeo } = require("../utils/geoSecurity");
const { sendMail, escapeHtml } = require("../utils/email");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const {
  normalizeEmail,
  verifyPassword,
  hashPassword,
  findByEmail,
  findByBranchId,
  getById,
  setPassword,
  upsertCredentials,
  listBranchAdmins,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
} = require("../utils/branchAccounts");
const { requestOtp, verifyOtp } = require("../utils/staffOtp");
const authenticateSuperAdmin = require("../middlewares/authenticateSuperAdmin");
const { recordAuditEvent, auditContextFromReq, ACTIONS } = require("../utils/auditLog");

const FALLBACK_TTL_MIN = Number(
  process.env.JWT_FALLBACK_TTL_MIN || process.env.JWT_ADMIN_TTL_MIN || "240"
);
const TICKET_TTL_MIN = Number(process.env.BRANCH_OTP_TICKET_TTL_MIN || 10);
const MFA_SESSION_COLLECTION = "mfa_sessions";
const MFA_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h — matches routes/mfa.js
const MIN_PASSWORD_LEN = Number(process.env.BRANCH_MIN_PASSWORD_LEN || 10);

// Staging/dev testing aid: when the OTP email can't be delivered (e.g. SMTP not
// configured / bad credentials), expose the code in the API response so the
// flow can still be tested. NEVER on in production unless BRANCH_OTP_DEV_ECHO=1
// is explicitly set on the backend.
const OTP_ECHO_ALLOWED =
  process.env.NODE_ENV !== "production" || process.env.BRANCH_OTP_DEV_ECHO === "1";

// Send the OTP email but NEVER let a delivery failure crash the login. Returns
// whether it was delivered (+ the error) so callers can surface it gracefully.
async function deliverOtpEmail(to, code, ttlSec, opts) {
  try {
    await sendCodeEmail(to, code, ttlSec, opts);
    return { emailSent: true, emailError: null };
  } catch (mailErr) {
    console.error("[BRANCH] OTP email delivery failed:", mailErr.message);
    return { emailSent: false, emailError: mailErr.message };
  }
}

// Lazily-built dummy hash so a "user not found" path still spends ~scrypt time,
// reducing user-enumeration via timing.
let DUMMY_HASH = null;
async function burnTimingBudget(password) {
  try {
    if (!DUMMY_HASH) DUMMY_HASH = await hashPassword("timing-equalization-placeholder");
    await verifyPassword(password || "x", DUMMY_HASH);
  } catch {
    /* ignore */
  }
}

function sessionIdFrom(req, account) {
  return (
    req.headers["x-session-id"] ||
    (req.body && req.body.sessionId) ||
    (account && account.id) ||
    "default"
  );
}

function setBranchAdminCookie(res, token) {
  const cookie = [
    `branchAdminToken=${token}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Strict`,
    `Partitioned`,
    `Max-Age=${FALLBACK_TTL_MIN * 60}`,
  ].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

async function issueBranchAdminToken(account) {
  const payload = {
    uid: account.id,
    branchId: account.branchId,
    email: account.email, // the branch email drives chat routing
    branchName: account.branchName || "Branch Admin",
    role: "branchadmin",
    fallback: true,
    authVia: "branch_email_otp",
  };
  return signJWT(payload, { expiresIn: `${FALLBACK_TTL_MIN}m` });
}

// ─────────────────────────────────────────────────────────────────────────────
// Firebase Auth session for the dashboard's client-side Firestore.
//
// The HMAC token above only authorizes the edge worker + Socket.IO. The chat
// dashboard ALSO reads chats/messages and writes presence directly via the
// Firebase client SDK, whose security rules require `request.auth` with a
// `branchadmin` role and an `email` claim equal to the branch email
// (firestore.rules). So we mint a Firebase custom token here and have the
// frontend signInWithCustomToken() — mirroring the Firebase-login path.
//
// Best-effort: a Firebase hiccup must never block an OTP login that already
// succeeded. Returns a custom-token string, or null on any failure.
// ─────────────────────────────────────────────────────────────────────────────
async function mintFirebaseToken(account) {
  try {
    const email = normalizeEmail(account.email);
    const claims = {
      role: "branchadmin",
      branchId: account.branchId,
      branchName: account.branchName || "Branch Admin",
      // The Firestore rules compare `request.auth.token.email == branchEmail`
      // (messages read + branchStatus write). Custom-token sessions do NOT
      // reliably carry the user-record email, so set it EXPLICITLY here.
      email,
      id: account.id,
    };

    // Resolve (or create) the Firebase Auth user for this branch email so the
    // minted session carries a real `email` claim matching branchEmail
    // (rules compare resource.data.branchEmail == request.auth.token.email).
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (e) {
      if (e.code === "auth/user-not-found") {
        userRecord = await admin.auth().createUser({ email, emailVerified: true });
      } else {
        throw e;
      }
    }

    // Keep persistent custom claims in sync (idempotent) so role/branchId hold
    // across future sessions too.
    const existing = userRecord.customClaims || {};
    const needsUpdate =
      existing.role !== claims.role ||
      existing.branchId !== claims.branchId ||
      existing.branchName !== claims.branchName ||
      existing.id !== claims.id;
    if (needsUpdate) {
      await admin.auth().setCustomUserClaims(userRecord.uid, { ...existing, ...claims });
    }

    // Pass claims as developer claims too so THIS token carries them immediately
    // (no propagation wait).
    return await admin.auth().createCustomToken(userRecord.uid, claims);
  } catch (e) {
    console.error("[BRANCH] Firebase custom-token mint failed:", e.message);
    return null;
  }
}

async function writeMfaSession(req, email, sessionId, via = "branch_email_otp") {
  const { ip, country } = getClientGeo(req);
  await db
    .collection(MFA_SESSION_COLLECTION)
    .doc(`${email}_${sessionId}`)
    .set({
      email,
      sessionId,
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + MFA_SESSION_TTL_MS).toISOString(),
      ip: ip || req.ip || null,
      country: country || null,
      geoLocked: false,
      userAgent: req.headers["user-agent"] || null,
      via,
    });
}

async function signLoginTicket(account) {
  return signJWT(
    { sub: account.id, email: account.email, purpose: "branch_otp_pending" },
    { expiresIn: `${TICKET_TTL_MIN}m` }
  );
}

async function verifyLoginTicket(ticket) {
  const decoded = await verifyJWT(ticket);
  if (!decoded || decoded.purpose !== "branch_otp_pending" || !decoded.email || !decoded.sub) {
    throw new Error("invalid_ticket");
  }
  return decoded;
}

async function sendCodeEmail(to, code, ttlSec, { reset = false } = {}) {
  const minutes = Math.max(1, Math.round((ttlSec || 600) / 60));
  const heading = reset ? "Reset your password" : "Your login code";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#1a1a2e;margin:0 0 8px;font-size:20px;">Magis Chat Dashboard</h2>
      <p style="color:#4b5563;margin:0 0 20px;">${escapeHtml(heading)} &mdash; enter this code to continue:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#1a1a2e;background:#faf8f5;border:1px solid #e5dcc8;border-radius:12px;padding:16px;text-align:center;">${escapeHtml(code)}</div>
      <p style="color:#6b7280;font-size:13px;margin:16px 0 0;line-height:1.6;">This code expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once. If you did not try to sign in, ignore this email and notify your administrator.</p>
    </div>`;
  const text =
    `Magis Chat Dashboard\n${heading} — enter this code to continue:\n\n${code}\n\n` +
    `Expires in ${minutes} minute(s). Single use. If you did not request this, ignore this email.`;
  await sendMail({
    to,
    subject: reset ? "Reset your Magis dashboard password" : "Your Magis dashboard login code",
    html,
    text,
  });
}

const OTP_ERROR_MAP = {
  NO_CODE: [410, "No active code. Please request a new one."],
  EXPIRED: [410, "Your code expired. Please request a new one."],
  TOO_MANY_ATTEMPTS: [429, "Too many incorrect attempts. Please request a new code."],
  INVALID: [401, "Incorrect code."],
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branch/login  { email, password }  — factor 1, then ALWAYS OTP.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", express.json(), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const account = await findByEmail(email);
    // No account, or no password set yet (legacy doc not seeded) → generic 401.
    if (!account || !account.passwordHash) {
      await burnTimingBudget(password);
      return res.status(401).json({ error: "Invalid email or password." });
    }
    if (account.status === "disabled") {
      return res.status(403).json({ error: "This account has been disabled. Contact your administrator." });
    }
    if (isLocked(account)) {
      recordAuditEvent({
        category: "auth",
        action: ACTIONS.AUTH_ACCOUNT_LOCKED,
        severity: "warning",
        outcome: "blocked",
        actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
        branchEmail: account.email,
        context: auditContextFromReq(req),
        meta: { stage: "login" },
      });
      return res.status(429).json({ error: "Account temporarily locked after too many attempts. Try again later." });
    }

    const ok = await verifyPassword(password, account.passwordHash);
    if (!ok) {
      await recordFailedLogin(account.id, account);
      recordAuditEvent({
        category: "auth",
        action: ACTIONS.AUTH_LOGIN_FAILURE,
        severity: "warning",
        outcome: "failure",
        actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
        branchEmail: account.email,
        context: auditContextFromReq(req),
        meta: { reason: "bad_password" },
      });
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // ALWAYS send an OTP to the branch's predefined email.
    const { ip } = getClientGeo(req);
    const otp = await requestOtp({
      email: account.email,
      sessionId: sessionIdFrom(req, account),
      ip,
      userAgent: req.headers["user-agent"],
    });
    if (!otp.ok) {
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfterSec: otp.retryAfterSec,
      });
    }
    const { emailSent, emailError } = await deliverOtpEmail(account.email, otp.code, otp.ttlSec);
    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_OTP_ISSUED,
      severity: "info",
      actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
      branchEmail: account.email,
      context: auditContextFromReq(req),
      meta: { emailSent, stage: "login" },
    });
    const loginTicket = await signLoginTicket(account);
    const payload = {
      otpRequired: true,
      loginTicket,
      email: account.email,
      expiresAt: otp.expiresAt,
      emailSent,
    };
    if (!emailSent) {
      payload.emailError = emailError;
      if (OTP_ECHO_ALLOWED) payload.devCode = otp.code;
    }
    return res.json(payload);
  } catch (e) {
    console.error("[BRANCH:login] ❌", e.message);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branch/login/verify-otp  { loginTicket, code }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login/verify-otp", express.json(), async (req, res) => {
  try {
    const { loginTicket, code } = req.body || {};
    if (!loginTicket || !code) {
      return res.status(400).json({ error: "Verification code is required." });
    }

    let decoded;
    try {
      decoded = await verifyLoginTicket(loginTicket);
    } catch {
      return res.status(401).json({ error: "Your login session expired. Please sign in again." });
    }

    const account = await getById(decoded.sub);
    if (!account || account.status === "disabled") {
      return res.status(403).json({ error: "Account unavailable. Contact your administrator." });
    }

    const result = await verifyOtp({ email: account.email, code });
    if (!result.ok) {
      recordAuditEvent({
        category: "auth",
        action: ACTIONS.AUTH_OTP_FAILED,
        severity: "warning",
        outcome: "failure",
        actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
        branchEmail: account.email,
        context: auditContextFromReq(req),
        meta: { reason: result.code },
      });
      const [status, msg] = OTP_ERROR_MAP[result.code] || [400, "Verification failed."];
      return res.status(status).json({ error: msg, attemptsLeft: result.attemptsLeft });
    }

    await recordSuccessfulLogin(account.id);
    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_LOGIN_SUCCESS,
      severity: "notice",
      actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
      branchEmail: account.email,
      context: auditContextFromReq(req),
      meta: { method: "password+otp" },
    });
    const token = await issueBranchAdminToken(account);
    setBranchAdminCookie(res, token);
    await writeMfaSession(req, account.email, sessionIdFrom(req, account));
    // Firebase custom token → frontend signInWithCustomToken() so the dashboard's
    // client-side Firestore (chats/messages/presence) is authorized. Best-effort.
    const firebaseToken = await mintFirebaseToken(account);

    return res.json({
      token,
      firebaseToken,
      mustChangePassword: Boolean(account.mustChangePassword),
      branchName: account.branchName,
    });
  } catch (e) {
    console.error("[BRANCH:verify-otp] ❌", e.message);
    return res.status(500).json({ error: "Verification failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branch/login/resend-otp  { loginTicket }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login/resend-otp", express.json(), async (req, res) => {
  try {
    const { loginTicket } = req.body || {};
    let decoded;
    try {
      decoded = await verifyLoginTicket(loginTicket);
    } catch {
      return res.status(401).json({ error: "Your login session expired. Please sign in again." });
    }
    const account = await getById(decoded.sub);
    if (!account || account.status === "disabled") {
      return res.status(403).json({ error: "Account unavailable." });
    }
    const { ip } = getClientGeo(req);
    const otp = await requestOtp({
      email: account.email,
      sessionId: sessionIdFrom(req, account),
      ip,
      userAgent: req.headers["user-agent"],
    });
    if (!otp.ok) {
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfterSec: otp.retryAfterSec,
      });
    }
    const { emailSent, emailError } = await deliverOtpEmail(account.email, otp.code, otp.ttlSec);
    const payload = { sent: emailSent, emailSent, expiresAt: otp.expiresAt };
    if (!emailSent) {
      payload.emailError = emailError;
      if (OTP_ECHO_ALLOWED) payload.devCode = otp.code;
    }
    return res.json(payload);
  } catch (e) {
    console.error("[BRANCH:resend-otp] ❌", e.message);
    return res.status(500).json({ error: "Could not resend code." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branch/change-password  (authenticated)
// { currentPassword, newPassword }  — covers the optional first-login change.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/change-password", authenticateBranchAdmin, express.json(), async (req, res) => {
  try {
    const account = await getById(req.user.uid);
    if (!account) return res.status(404).json({ error: "Account not found." });

    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < MIN_PASSWORD_LEN) {
      return res
        .status(400)
        .json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
    }
    const ok = await verifyPassword(currentPassword || "", account.passwordHash || "");
    if (!ok) return res.status(401).json({ error: "Current password is incorrect." });

    await setPassword(account.id, newPassword, { mustChangePassword: false });
    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_PASSWORD_CHANGED,
      severity: "notice",
      actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
      branchEmail: account.email,
      context: auditContextFromReq(req),
      meta: { self: true },
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("[BRANCH:change-password] ❌", e.message);
    return res.status(500).json({ error: "Could not change password." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branch/firebase-token  (authenticated)
// Re-mint a Firebase custom token for the CURRENT branch-admin session so the
// dashboard can (re)establish its Firebase Auth session on page reload / a
// reopened tab — not only immediately after OTP login. Without this, the
// client-side Firestore (chats/messages/presence) is permission-denied after any
// reload because Firebase's browserSessionPersistence was cleared while the HMAC
// session is still valid. Best-effort; the HMAC session is unaffected on failure.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/firebase-token", authenticateBranchAdmin, async (req, res) => {
  try {
    const account = {
      id: req.user?.uid || req.user?.id || req.branchEmail,
      email: req.branchEmail,
      branchId: req.branchId,
      branchName: req.branchName,
    };
    const firebaseToken = await mintFirebaseToken(account);
    if (!firebaseToken) {
      return res.status(503).json({ error: "Could not establish Firebase session." });
    }
    return res.json({ firebaseToken });
  } catch (e) {
    console.error("[BRANCH:firebase-token] ❌", e.message);
    return res.status(500).json({ error: "Could not issue Firebase token." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branch/forgot  { email }  — emails a reset code (anti-enumeration:
// always returns ok). POST /api/branch/reset { email, code, newPassword }.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/forgot", express.json(), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: "Email is required." });
    const account = await findByEmail(email);
    if (account && account.status !== "disabled") {
      const { ip } = getClientGeo(req);
      const otp = await requestOtp({
        email: account.email,
        sessionId: "reset",
        ip,
        userAgent: req.headers["user-agent"],
      });
      if (otp.ok) {
        await sendCodeEmail(account.email, otp.code, otp.ttlSec, { reset: true });
      }
    }
    // Always generic so we never reveal whether an email exists.
    return res.json({ ok: true });
  } catch (e) {
    console.error("[BRANCH:forgot] ❌", e.message);
    return res.json({ ok: true });
  }
});

router.post("/reset", express.json(), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { code, newPassword } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: "Email and code are required." });
    if (!newPassword || String(newPassword).length < MIN_PASSWORD_LEN) {
      return res
        .status(400)
        .json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
    }
    const result = await verifyOtp({ email, code });
    if (!result.ok) {
      const [status, msg] = OTP_ERROR_MAP[result.code] || [400, "Verification failed."];
      return res.status(status).json({ error: msg, attemptsLeft: result.attemptsLeft });
    }
    const account = await findByEmail(email);
    if (!account) return res.status(400).json({ error: "Verification failed." });
    await setPassword(account.id, newPassword, { mustChangePassword: false });
    recordAuditEvent({
      category: "auth",
      action: ACTIONS.AUTH_PASSWORD_RESET,
      severity: "notice",
      actor: { type: "branchadmin", id: account.id, email: account.email, branchEmail: account.email },
      branchEmail: account.email,
      context: auditContextFromReq(req),
      meta: { via: "reset_code" },
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("[BRANCH:reset] ❌", e.message);
    return res.status(500).json({ error: "Could not reset password." });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Super-admin: predefine/reset a branch's login password (writes to branchAdmins)
// and list which branches have credentials. Edge-bypassed like /api/admin/staff;
// the backend's authenticateSuperAdmin is the authority.
// ─────────────────────────────────────────────────────────────────────────
router.post("/admin/set-password", authenticateSuperAdmin, express.json(), async (req, res) => {
  try {
    const { branchId, email, password, mustChangePassword = true } = req.body || {};
    if (!branchId) return res.status(400).json({ error: "branchId is required." });
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    let loginEmail = normalizeEmail(email);
    if (!loginEmail) {
      const existing = await findByBranchId(branchId);
      loginEmail = existing?.email || "";
    }
    if (!loginEmail) {
      const branchSnap = await db.collection("branches").doc(String(branchId)).get();
      loginEmail = normalizeEmail(branchSnap.exists && branchSnap.data().email);
    }
    if (!loginEmail) {
      return res
        .status(400)
        .json({ error: "No login email found for this branch. Provide an email." });
    }

    const { id } = await upsertCredentials({
      email: loginEmail,
      branchId,
      password,
      mustChangePassword: Boolean(mustChangePassword),
      passwordSetBy: (req.user && (req.user.email || req.user.uid)) || "superadmin",
    });
    recordAuditEvent({
      category: "admin",
      action: ACTIONS.ADMIN_BRANCH_PASSWORD_SET,
      severity: "notice",
      actor: { type: "superadmin", id: req.superAdminId, email: req.superAdminEmail, role: "superadmin" },
      branchEmail: loginEmail,
      target: { type: "branch", id: branchId },
      context: auditContextFromReq(req),
      meta: { mustChangePassword: Boolean(mustChangePassword) },
    });
    return res.json({ success: true, id, email: loginEmail });
  } catch (e) {
    console.error("[BRANCH:set-password] \u274c", e.message);
    return res.status(500).json({ error: "Could not set branch password." });
  }
});

router.get("/admin/list", authenticateSuperAdmin, async (req, res) => {
  try {
    const list = await listBranchAdmins();
    return res.json(list);
  } catch (e) {
    console.error("[BRANCH:admin-list] \u274c", e.message);
    return res.status(500).json({ error: "Could not list branch credentials." });
  }
});

module.exports = router;

// Shared session-issuance helpers (megaplan Phase 5): the WebAuthn/passkey
// route reuses these so a passkey login yields EXACTLY the same session
// artifacts as the OTP path — same HMAC token shape, same cookie attributes,
// same mfa_sessions doc, same Firebase custom token. Attached as named props
// on the router export (require() returns the router object).
module.exports.issueBranchAdminToken = issueBranchAdminToken;
module.exports.setBranchAdminCookie = setBranchAdminCookie;
module.exports.writeMfaSession = writeMfaSession;
module.exports.mintFirebaseToken = mintFirebaseToken;
module.exports.sessionIdFrom = sessionIdFrom;
