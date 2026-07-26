// backend/utils/email.js
//
// Small reusable email helper (nodemailer). Centralizes the transporter so the
// new staff-access module (credential + OTP emails) and any future feature can
// send mail without re-implementing transport config in each route.
//
// Credentials (first match wins):
//   1) BRANCH_SMTP_USER / BRANCH_SMTP_PASS   (dedicated branch-login mailbox)
//   2) SMTP_USER / SMTP_PASS                 (generic SMTP)
//   3) SUPPORT_EMAIL / SUPPORT_EMAIL_PASSWORD (legacy contact-form account)
//
// Transport: an explicit SMTP host (BRANCH_SMTP_HOST or SMTP_HOST) if set,
// otherwise the Gmail service (works with a Gmail App Password).
//
// This module is ADDITIVE: it does not modify or replace the inline mailer in
// guest.js, so existing email behavior is unchanged.

const nodemailer = require("nodemailer");

let cachedTransporter = null;

/** Resolve the sending account user/pass from env (BRANCH_SMTP_* preferred). */
function resolveCreds() {
  const user =
    process.env.BRANCH_SMTP_USER ||
    process.env.SMTP_USER ||
    process.env.SUPPORT_EMAIL ||
    "";
  const pass =
    process.env.BRANCH_SMTP_PASS ||
    process.env.SMTP_PASS ||
    process.env.SUPPORT_EMAIL_PASSWORD ||
    "";
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

  // Shared latency/robustness settings:
  //   pool           — keep the authenticated TLS connection warm between
  //                    sends. Without it EVERY OTP email pays a fresh
  //                    DNS + TCP + TLS + AUTH handshake (seconds on a cold
  //                    Gmail connection) — the "Sending…" delay users saw.
  //   *Timeout       — nodemailer's defaults allow a stalled SMTP conversation
  //                    to hang for ~2 minutes; login's awaited email path must
  //                    fail fast instead so the UI gets its emailSent:false.
  const shared = {
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };

  const host = process.env.BRANCH_SMTP_HOST || process.env.SMTP_HOST;
  if (host) {
    cachedTransporter = nodemailer.createTransport({
      ...shared,
      host,
      port: Number(process.env.BRANCH_SMTP_PORT || process.env.SMTP_PORT || 587),
      secure:
        String(process.env.BRANCH_SMTP_SECURE || process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: user ? { user, pass } : undefined,
    });
  } else {
    // Matches the existing Gmail-based contact mailer (routes/guest.js).
    cachedTransporter = nodemailer.createTransport({
      ...shared,
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
