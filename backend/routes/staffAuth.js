// backend/routes/staffAuth.js
//
// Staff authentication for the branch chat dashboard: PASSWORD (factor 1) +
// emailed 6-digit OTP (factor 2). Phone-free, computer-friendly.
//
// ZERO-REGRESSION DESIGN:
//   - These accounts live in `staffAccounts` (utils/staffAccounts.js) and are
//     NOT Firebase Auth users, so they never touch the Firebase login or the
//     hardened /api/issue-fallback-token endpoint.
//   - On success this route mints the SAME `branchadmin` HMAC token + cookie
//     that issue-fallback-token mints, and writes the SAME `mfa_sessions` doc
//     that middlewares/requireMFA.js checks — so the dashboard, socket auth,
//     and SPI gating all work for staff with no downstream changes.
//
// Mandatory-2FA cannot be bypassed: because staff have no Firebase identity,
// the ONLY way to obtain a branchadmin token for these accounts is to complete
// the password + OTP flow below.

const express = require("express");
const router = express.Router();

const { db } = require("../utils/firebase");
const { signJWT, verifyJWT } = require("../utils/secretPool");
const { getClientGeo } = require("../utils/geoSecurity");
const { sendMail, escapeHtml } = require("../utils/email");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const {
  normalizeEmail,
  verifyPassword,
  hashPassword,
  findByEmail,
  getById,
  setPassword,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
} = require("../utils/staffAccounts");
const { requestOtp, verifyOtp } = require("../utils/staffOtp");
const {
  createTrustedDevice,
  verifyTrustedDevice,
} = require("../utils/staffTrustedDevice");

// Token lifetime mirrors the existing fallback (HMAC) admin token.
const FALLBACK_TTL_MIN = Number(
  process.env.JWT_FALLBACK_TTL_MIN || process.env.JWT_ADMIN_TTL_MIN || "240"
);
const TICKET_TTL_MIN = Number(process.env.STAFF_OTP_TICKET_TTL_MIN || 10);
const MFA_SESSION_COLLECTION = "mfa_sessions";
const MFA_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h — matches routes/mfa.js
const MIN_PASSWORD_LEN = Number(process.env.STAFF_MIN_PASSWORD_LEN || 10);

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

function sessionIdFrom(req, staff) {
  return (
    req.headers["x-session-id"] ||
    (req.body && req.body.sessionId) ||
    (staff && staff.id) ||
    (req.user && req.user.uid) ||
    "default"
  );
}

function setBranchAdminCookie(res, token) {
  // Identical attributes to /api/issue-fallback-token (server.js).
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

async function issueBranchAdminToken(staff) {
  const payload = {
    uid: staff.id,
    branchId: staff.branchId,
    // The BRANCH's email drives chat routing (admin-<branchEmail> room + message
    // hard-filter), exactly like a real branch admin whose login email IS the
    // branch email. The staffer's personal login email is carried separately.
    email: staff.branchEmail || staff.email,
    staffEmail: staff.email,
    branchName: staff.branchName || "Branch Admin",
    role: "branchadmin",
    fallback: true,
    authVia: "staff_email_otp",
    staff: true, // marks this as a staffAccounts identity (no Firebase user)
  };
  return signJWT(payload, { expiresIn: `${FALLBACK_TTL_MIN}m` });
}

// Establish the MFA session that requireMFA (SPI gate) checks. Shape mirrors
// routes/mfa.js session-verify, including the geo baseline used by the existing
// international-anomaly detection.
async function writeMfaSession(req, email, sessionId) {
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
      via: "staff_email_otp",
    });
}

// Short-lived ticket proving the PASSWORD step passed; required by /verify-otp
// and /resend-otp so the OTP step can't be driven without a prior password win.
async function signLoginTicket(staff) {
  return signJWT(
    { sub: staff.id, email: staff.email, purpose: "staff_otp_pending", staff: true },
    { expiresIn: `${TICKET_TTL_MIN}m` }
  );
}

async function verifyLoginTicket(ticket) {
  const decoded = await verifyJWT(ticket);
  if (!decoded || decoded.purpose !== "staff_otp_pending" || !decoded.email || !decoded.sub) {
    throw new Error("invalid_ticket");
  }
  return decoded;
}

async function sendOtpEmail(to, code, ttlSec, { stepUp = false } = {}) {
  const minutes = Math.max(1, Math.round((ttlSec || 600) / 60));
  const heading = stepUp ? "Re-verify your identity" : "Your login code";
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
  await sendMail({ to, subject: "Your Magis dashboard verification code", html, text });
}

const OTP_ERROR_MAP = {
  NO_CODE: [410, "No active code. Please request a new one."],
  EXPIRED: [410, "Your code expired. Please request a new one."],
  TOO_MANY_ATTEMPTS: [429, "Too many incorrect attempts. Please request a new code."],
  INVALID: [401, "Incorrect code."],
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/staff/login  { email, password }
// Factor 1. On success either issues a token (2FA disabled) or emails an OTP and
// returns a short-lived loginTicket (2FA enabled).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", express.json(), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const staff = await findByEmail(email);
    if (!staff) {
      await burnTimingBudget(password); // equalize timing vs. the valid path
      return res.status(401).json({ error: "Invalid email or password." });
    }
    if (staff.status === "disabled") {
      return res.status(403).json({ error: "This account has been disabled. Contact your administrator." });
    }
    if (isLocked(staff)) {
      return res.status(429).json({ error: "Account temporarily locked after too many attempts. Try again later." });
    }

    const ok = await verifyPassword(password, staff.passwordHash || "");
    if (!ok) {
      await recordFailedLogin(staff.id, staff);
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // 2FA disabled by an admin → issue the token directly (factor 1 only).
    if (!staff.twoFactorEnabled) {
      await recordSuccessfulLogin(staff.id);
      const token = await issueBranchAdminToken(staff);
      setBranchAdminCookie(res, token);
      await writeMfaSession(req, staff.branchEmail || staff.email, sessionIdFrom(req, staff));
      return res.json({
        token,
        twoFactor: false,
        mustChangePassword: Boolean(staff.mustChangePassword),
        branchName: staff.branchName,
      });
    }

    // 2FA enabled, but this DEVICE may already be trusted ("remember this
    // device") → skip the emailed code. The password (factor 1) was just
    // verified; a valid trusted-device token is factor 2 (possession of this
    // computer). The token is client-stored and replayed in the body, which
    // works cross-origin / in Electron (like the branchAdminToken).
    const trustedToken = req.body.trustedDeviceToken;
    if (trustedToken && (await verifyTrustedDevice({ token: trustedToken, staffId: staff.id }))) {
      await recordSuccessfulLogin(staff.id);
      const token = await issueBranchAdminToken(staff);
      setBranchAdminCookie(res, token);
      await writeMfaSession(req, staff.branchEmail || staff.email, sessionIdFrom(req, staff));
      return res.json({
        token,
        trusted: true,
        mustChangePassword: Boolean(staff.mustChangePassword),
        branchName: staff.branchName,
      });
    }

    // 2FA enabled → email an OTP, return a ticket binding the next step.
    const { ip } = getClientGeo(req);
    const otp = await requestOtp({
      email: staff.email,
      sessionId: sessionIdFrom(req, staff),
      ip,
      userAgent: req.headers["user-agent"],
    });
    if (!otp.ok) {
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfterSec: otp.retryAfterSec,
      });
    }
    await sendOtpEmail(staff.email, otp.code, otp.ttlSec);
    const loginTicket = await signLoginTicket(staff);
    return res.json({
      otpRequired: true,
      loginTicket,
      email: staff.email,
      expiresAt: otp.expiresAt,
    });
  } catch (e) {
    console.error("[STAFF:login] ❌", e.message);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/staff/login/verify-otp  { loginTicket, code }
// Factor 2. On success issues the branchadmin token + MFA session.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login/verify-otp", express.json(), async (req, res) => {
  try {
    const { loginTicket, code, rememberDevice } = req.body || {};
    if (!loginTicket || !code) {
      return res.status(400).json({ error: "Verification code is required." });
    }

    let decoded;
    try {
      decoded = await verifyLoginTicket(loginTicket);
    } catch {
      return res.status(401).json({ error: "Your login session expired. Please sign in again." });
    }

    const staff = await getById(decoded.sub);
    if (!staff || staff.status === "disabled") {
      return res.status(403).json({ error: "Account unavailable. Contact your administrator." });
    }

    const result = await verifyOtp({ email: staff.email, code });
    if (!result.ok) {
      const [status, msg] = OTP_ERROR_MAP[result.code] || [400, "Verification failed."];
      return res.status(status).json({ error: msg, attemptsLeft: result.attemptsLeft });
    }

    await recordSuccessfulLogin(staff.id);
    const token = await issueBranchAdminToken(staff);
    setBranchAdminCookie(res, token);
    await writeMfaSession(req, staff.branchEmail || staff.email, sessionIdFrom(req, staff));

    // "Remember this device" → mint a trusted-device token the client stores and
    // replays on future logins to skip the emailed code (revocable by an admin).
    let trustedDeviceToken = null;
    if (rememberDevice) {
      try {
        const td = await createTrustedDevice({
          staffId: staff.id,
          email: staff.email,
          userAgent: req.headers["user-agent"],
        });
        trustedDeviceToken = td.token;
      } catch (e) {
        console.warn("[STAFF:verify-otp] Could not create trusted device:", e.message);
      }
    }

    return res.json({
      token,
      mustChangePassword: Boolean(staff.mustChangePassword),
      branchName: staff.branchName,
      trustedDeviceToken,
    });
  } catch (e) {
    console.error("[STAFF:verify-otp] ❌", e.message);
    return res.status(500).json({ error: "Verification failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/staff/login/resend-otp  { loginTicket }
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
    const staff = await getById(decoded.sub);
    if (!staff || staff.status === "disabled") {
      return res.status(403).json({ error: "Account unavailable." });
    }
    const { ip } = getClientGeo(req);
    const otp = await requestOtp({
      email: staff.email,
      sessionId: sessionIdFrom(req, staff),
      ip,
      userAgent: req.headers["user-agent"],
    });
    if (!otp.ok) {
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfterSec: otp.retryAfterSec,
      });
    }
    await sendOtpEmail(staff.email, otp.code, otp.ttlSec);
    return res.json({ sent: true, expiresAt: otp.expiresAt });
  } catch (e) {
    console.error("[STAFF:resend-otp] ❌", e.message);
    return res.status(500).json({ error: "Could not resend code." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/staff/change-password  (authenticated staff)
// { currentPassword, newPassword }  — supports the first-login forced change.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/change-password", authenticateBranchAdmin, express.json(), async (req, res) => {
  try {
    if (!req.user || req.user.staff !== true) {
      return res.status(403).json({ error: "Not a staff account." });
    }
    const staff = await getById(req.user.uid);
    if (!staff) return res.status(404).json({ error: "Account not found." });

    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < MIN_PASSWORD_LEN) {
      return res
        .status(400)
        .json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
    }
    const ok = await verifyPassword(currentPassword || "", staff.passwordHash || "");
    if (!ok) return res.status(401).json({ error: "Current password is incorrect." });

    await setPassword(staff.id, newPassword, { mustChangePassword: false });
    return res.json({ success: true });
  } catch (e) {
    console.error("[STAFF:change-password] ❌", e.message);
    return res.status(500).json({ error: "Could not change password." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Step-up re-verification (authenticated staff): used by the dashboard when the
// 8h MFA session expires or a geo anomaly locks it. Re-issues an OTP and, on
// success, refreshes the MFA session — the email-OTP analogue of the existing
// Firebase TOTP step-up in routes/mfa.js.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/stepup/request", authenticateBranchAdmin, async (req, res) => {
  try {
    if (!req.user || req.user.staff !== true) {
      return res.status(403).json({ error: "Not a staff account." });
    }
    const staff = await getById(req.user.uid);
    if (!staff || staff.status === "disabled") {
      return res.status(403).json({ error: "Account unavailable." });
    }
    const { ip } = getClientGeo(req);
    const otp = await requestOtp({
      email: staff.email, // the staffer's personal inbox (second-factor delivery)
      sessionId: sessionIdFrom(req, staff),
      ip,
      userAgent: req.headers["user-agent"],
    });
    if (!otp.ok) {
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfterSec: otp.retryAfterSec,
      });
    }
    await sendOtpEmail(staff.email, otp.code, otp.ttlSec, { stepUp: true });
    return res.json({ sent: true, expiresAt: otp.expiresAt });
  } catch (e) {
    console.error("[STAFF:stepup:request] ❌", e.message);
    return res.status(500).json({ error: "Could not send code." });
  }
});

router.post("/stepup/verify", authenticateBranchAdmin, express.json(), async (req, res) => {
  try {
    if (!req.user || req.user.staff !== true) {
      return res.status(403).json({ error: "Not a staff account." });
    }
    const staff = await getById(req.user.uid);
    if (!staff) return res.status(404).json({ error: "Account not found." });
    const result = await verifyOtp({ email: staff.email, code: (req.body || {}).code });
    if (!result.ok) {
      const [status, msg] = OTP_ERROR_MAP[result.code] || [400, "Verification failed."];
      return res.status(status).json({ error: msg, attemptsLeft: result.attemptsLeft });
    }
    await writeMfaSession(req, staff.branchEmail || staff.email, sessionIdFrom(req, staff));
    return res.json({ success: true, verified: true });
  } catch (e) {
    console.error("[STAFF:stepup:verify] ❌", e.message);
    return res.status(500).json({ error: "Verification failed. Please try again." });
  }
});

module.exports = router;
