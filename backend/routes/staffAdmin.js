// backend/routes/staffAdmin.js
//
// Super-admin management of branch chat-dashboard STAFF accounts
// (the password + email-OTP identities in `staffAccounts`).
//
// Every route requires a Super Admin (authenticateSuperAdmin), exactly like the
// existing routes/branches.js admin surface. This module only reads/writes the
// new `staffAccounts` collection (and clears `mfa_sessions`/`staff_otps` for a
// managed user) — it never touches existing Firebase/admin auth.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const { db } = require("../utils/firebase");
const authenticateSuperAdmin = require("../middlewares/authenticateSuperAdmin");
const { sendMail, escapeHtml } = require("../utils/email");
const {
  normalizeEmail,
  createStaff,
  listStaff,
  getById,
  findByBranchId,
  updateStaff,
  setPassword,
  deleteStaff,
  publicView,
} = require("../utils/staffAccounts");
const { clearOtp } = require("../utils/staffOtp");
const { revokeAllForStaff } = require("../utils/staffTrustedDevice");

// All staff-admin endpoints are Super-Admin only.
router.use(authenticateSuperAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Generate a strong, unambiguous temporary password. */
function generateTempPassword(len = 16) {
  // No look-alike chars (0/O, 1/l/I) to ease manual relay if needed.
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*?";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

/** Delete all MFA sessions for an email → immediate SPI lockout even if a token is still live. */
async function clearMfaSessions(email) {
  try {
    const snap = await db.collection("mfa_sessions").where("email", "==", normalizeEmail(email)).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (e) {
    console.warn("[STAFF:admin] clearMfaSessions failed:", e.message);
  }
}

async function sendCredentialEmail({ to, tempPassword, branchName, isReset }) {
  const loginUrl = process.env.STAFF_LOGIN_URL || process.env.ADMIN_FRONTEND_URL || "";
  const urlLine = loginUrl
    ? `<p style="margin:0 0 16px;color:#4b5563;">Sign in here: <a href="${escapeHtml(loginUrl)}" style="color:#b8941f;">${escapeHtml(loginUrl)}</a></p>`
    : "";
  const intro = isReset
    ? "Your Magis Chat Dashboard password has been reset by an administrator."
    : `An administrator has created your Magis Chat Dashboard account${
        branchName ? ` for <strong>${escapeHtml(branchName)}</strong>` : ""
      }.`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="color:#1a1a2e;margin:0 0 12px;font-size:20px;">Magis Chat Dashboard</h2>
      <p style="color:#4b5563;margin:0 0 16px;">${intro}</p>
      ${urlLine}
      <table style="border-collapse:collapse;margin:0 0 16px;">
        <tr><td style="padding:6px 12px;color:#6b7280;">Email</td><td style="padding:6px 12px;color:#1a1a2e;font-weight:600;">${escapeHtml(to)}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Temporary password</td><td style="padding:6px 12px;"><code style="font-size:15px;background:#faf8f5;border:1px solid #e5dcc8;border-radius:6px;padding:4px 8px;">${escapeHtml(tempPassword)}</code></td></tr>
      </table>
      <p style="color:#4b5563;margin:0 0 8px;">For your security:</p>
      <ul style="color:#4b5563;font-size:14px;line-height:1.7;margin:0 0 16px;padding-left:20px;">
        <li>You'll be asked to set a new password on first sign-in.</li>
        <li>A one-time 6-digit code will be emailed to this address each time you log in.</li>
        <li>Keep this email private and delete it after your first sign-in.</li>
      </ul>
      <p style="color:#6b7280;font-size:13px;margin:0;">If you weren't expecting this, contact your administrator.</p>
    </div>`;
  const text =
    `Magis Chat Dashboard\n\n${isReset ? "Your password has been reset." : "Your account has been created."}\n` +
    `${loginUrl ? `Sign in: ${loginUrl}\n` : ""}Email: ${to}\nTemporary password: ${tempPassword}\n\n` +
    `You'll set a new password on first sign-in. A 6-digit code is emailed each login. Keep this private.`;
  await sendMail({
    to,
    subject: isReset ? "Your Magis dashboard password was reset" : "Your Magis Chat Dashboard access",
    html,
    text,
  });
}

// ── List ─────────────────────────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    const staff = await listStaff();
    return res.json({ staff });
  } catch (e) {
    console.error("[STAFF:list] ❌", e.message);
    return res.status(500).json({ error: "Could not list staff." });
  }
});

// ── Create ───────────────────────────────────────────────────────────────────
// Generates a temp password, emails the credentials, and (as a fallback for
// email-delivery failures) returns the temp password ONCE to the super admin.
router.post("/", express.json(), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { branchId, branchName, branchEmail, displayName } = req.body || {};
    const twoFactorEnabled = req.body.twoFactorEnabled !== false; // default true

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    if (!branchId || !branchName) {
      return res.status(400).json({ error: "branchId and branchName are required." });
    }
    if (!branchEmail || !EMAIL_RE.test(normalizeEmail(branchEmail))) {
      return res.status(400).json({ error: "A valid branch email (the branch's chat identity) is required." });
    }

    const tempPassword = generateTempPassword();
    let created;
    try {
      created = await createStaff({
        email,
        password: tempPassword,
        branchId,
        branchName,
        branchEmail,
        displayName,
        createdBy: req.superAdminEmail,
        twoFactorEnabled,
      });
    } catch (e) {
      if (e.code === "EMAIL_EXISTS") {
        return res.status(409).json({ error: "A staff account with that email already exists." });
      }
      if (e.code === "BRANCH_EXISTS") {
        return res.status(409).json({ error: "This branch already has a staff account. Each branch can have only one staff member." });
      }
      throw e;
    }

    let emailed = false;
    let emailError = null;
    try {
      await sendCredentialEmail({ to: email, tempPassword, branchName, isReset: false });
      emailed = true;
    } catch (e) {
      emailError = e.message;
      console.error("[STAFF:create:email] ❌", e.message);
    }

    const staff = await getById(created.id);
    return res.status(201).json({
      staff: publicView(staff.id, staff),
      emailed,
      emailError,
      tempPassword, // shown once so the admin can relay it if email delivery failed
    });
  } catch (e) {
    console.error("[STAFF:create] ❌", e.message);
    return res.status(500).json({ error: "Could not create staff account." });
  }
});

// ── Update (branch reassign / display name) ──────────────────────────────────
router.patch("/:id", express.json(), async (req, res) => {
  try {
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });

    const patch = {};
    for (const k of ["branchId", "branchName", "branchEmail", "displayName"]) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    if (patch.branchEmail) patch.branchEmail = normalizeEmail(patch.branchEmail);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided." });
    }
    // One staff account per branch: block reassigning to a branch already taken.
    if (patch.branchId && patch.branchId !== staff.branchId) {
      const taken = await findByBranchId(patch.branchId, { excludeId: staff.id });
      if (taken) {
        return res.status(409).json({ error: "That branch already has a staff account. Each branch can have only one staff member." });
      }
    }
    const updated = await updateStaff(staff.id, patch);
    return res.json({ staff: publicView(updated.id, updated) });
  } catch (e) {
    console.error("[STAFF:update] ❌", e.message);
    return res.status(500).json({ error: "Could not update staff account." });
  }
});

// ── Reset password (emails a new temp password; forces change on next login) ──
router.post("/:id/reset-password", async (req, res) => {
  try {
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });

    const tempPassword = generateTempPassword();
    await setPassword(staff.id, tempPassword, { mustChangePassword: true });
    await clearMfaSessions(staff.email); // force full re-auth everywhere
    await revokeAllForStaff(staff.id); // require the emailed code again on every device

    let emailed = false;
    let emailError = null;
    try {
      await sendCredentialEmail({ to: staff.email, tempPassword, branchName: staff.branchName, isReset: true });
      emailed = true;
    } catch (e) {
      emailError = e.message;
      console.error("[STAFF:reset:email] ❌", e.message);
    }
    return res.json({ emailed, emailError, tempPassword });
  } catch (e) {
    console.error("[STAFF:reset-password] ❌", e.message);
    return res.status(500).json({ error: "Could not reset password." });
  }
});

// ── Toggle 2FA (admins can disable 2FA for a staffer) ────────────────────────
router.post("/:id/2fa", express.json(), async (req, res) => {
  try {
    const enabled = req.body.enabled === true;
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });
    await updateStaff(staff.id, { twoFactorEnabled: enabled });
    if (!enabled) await clearOtp(staff.email);
    await revokeAllForStaff(staff.id); // re-establish device trust under the new setting
    return res.json({ success: true, twoFactorEnabled: enabled });
  } catch (e) {
    console.error("[STAFF:2fa] ❌", e.message);
    return res.status(500).json({ error: "Could not update 2FA setting." });
  }
});

// ── Disable / Enable ─────────────────────────────────────────────────────────
router.post("/:id/disable", async (req, res) => {
  try {
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });
    await updateStaff(staff.id, { status: "disabled" });
    await clearMfaSessions(staff.email);
    await clearOtp(staff.email);
    await revokeAllForStaff(staff.id);
    return res.json({ success: true, status: "disabled" });
  } catch (e) {
    console.error("[STAFF:disable] ❌", e.message);
    return res.status(500).json({ error: "Could not disable account." });
  }
});

router.post("/:id/enable", async (req, res) => {
  try {
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });
    await updateStaff(staff.id, { status: "active", failedLoginCount: 0, lockedUntil: null });
    return res.json({ success: true, status: "active" });
  } catch (e) {
    console.error("[STAFF:enable] ❌", e.message);
    return res.status(500).json({ error: "Could not enable account." });
  }
});

// ── Revoke trusted devices (force the emailed code again on every device) ─────
router.post("/:id/revoke-devices", async (req, res) => {
  try {
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });
    const revoked = await revokeAllForStaff(staff.id);
    return res.json({ success: true, revoked });
  } catch (e) {
    console.error("[STAFF:revoke-devices] ❌", e.message);
    return res.status(500).json({ error: "Could not revoke trusted devices." });
  }
});

// ── Delete ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const staff = await getById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff account not found." });
    await deleteStaff(staff.id);
    await clearMfaSessions(staff.email);
    await clearOtp(staff.email);
    await revokeAllForStaff(staff.id);
    return res.json({ success: true });
  } catch (e) {
    console.error("[STAFF:delete] ❌", e.message);
    return res.status(500).json({ error: "Could not delete account." });
  }
});

module.exports = router;
