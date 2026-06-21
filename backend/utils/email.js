// backend/utils/email.js
//
// Small reusable email helper (nodemailer). Centralizes the transporter so the
// new staff-access module (credential + OTP emails) and any future feature can
// send mail without re-implementing transport config in each route.
//
// Transport selection (first match wins):
//   1) Explicit SMTP_* config (SMTP_HOST/PORT/SECURE/USER/PASS)
//   2) Gmail service via SUPPORT_EMAIL / SUPPORT_EMAIL_PASSWORD
//      (identical to the working contact-form mailer in routes/guest.js)
//
// This module is ADDITIVE: it does not modify or replace the inline mailer in
// guest.js, so existing email behavior is unchanged.

const nodemailer = require("nodemailer");

let cachedTransporter = null;

/** Resolve the sending account user/pass from env (SMTP_* preferred). */
function resolveCreds() {
  const user = process.env.SMTP_USER || process.env.SUPPORT_EMAIL || "";
  const pass = process.env.SMTP_PASS || process.env.SUPPORT_EMAIL_PASSWORD || "";
  return { user, pass };
}

/** True when at least a sending account is configured. */
function isEmailConfigured() {
  const { user, pass } = resolveCreds();
  return Boolean(user && pass);
}

/** Build (and cache) the nodemailer transporter. */
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const { user, pass } = resolveCreds();

  if (process.env.SMTP_HOST) {
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: user ? { user, pass } : undefined,
    });
  } else {
    // Matches the existing Gmail-based contact mailer (routes/guest.js).
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }
  return cachedTransporter;
}

/** Display "From" header, e.g. "Magis Admin <no-reply@…>". */
function fromAddress() {
  const { user } = resolveCreds();
  const name = process.env.MAIL_FROM_NAME || "Magis Admin";
  return `"${name}" <${user}>`;
}

/** Minimal HTML escaping for any dynamic values interpolated into templates. */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send an email. Throws if no transport is configured so callers can surface a
 * clear error rather than silently dropping a security-relevant message.
 * @param {{ to:string, subject:string, html?:string, text?:string, replyTo?:string }} opts
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!to || !subject) throw new Error("sendMail requires 'to' and 'subject'.");
  if (!isEmailConfigured()) {
    throw new Error(
      "Email is not configured (set SMTP_* or SUPPORT_EMAIL/SUPPORT_EMAIL_PASSWORD)."
    );
  }
  const transporter = getTransporter();
  return transporter.sendMail({
    from: fromAddress(),
    to,
    subject,
    text: text || undefined,
    html: html || undefined,
    replyTo: replyTo || undefined,
  });
}

module.exports = {
  sendMail,
  isEmailConfigured,
  fromAddress,
  escapeHtml,
  getTransporter,
};
