// routes/contact.js
//
// Public "Contact Us" form endpoint (POST /api/contact).
// - No auth: the site's contact form is anonymous. Abuse is mitigated by the
//   per-IP rate limiter mounted in server.js (contactLimiter) + an OPTIONAL
//   Cloudflare Turnstile check (dormant unless TURNSTILE_SECRET is configured).
// - Primary sink is Firestore (`contactMessages`), so submissions are never lost
//   even when SMTP isn't configured. Email notification is best-effort on top.
// - The sender's email is only ever used as reply-to (never a recipient), so
//   this endpoint can't be abused as an open mail relay.

const express = require("express");
const router = express.Router();
const { db, admin } = require("../utils/firebase");
const nodemailer = require("nodemailer");

// Optional Cloudflare Turnstile verification (no-op unless TURNSTILE_SECRET set).
// Mirrors the public /api/guest/init behavior; fails OPEN on verifier outage so
// the per-IP rate-limit remains the backstop.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";
const TURNSTILE_ENFORCE = process.env.TURNSTILE_ENFORCE !== "false";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: "missing-token" };
  try {
    const body = new URLSearchParams();
    body.append("secret", TURNSTILE_SECRET);
    body.append("response", token);
    if (ip) body.append("remoteip", ip);
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await r.json();
    return { ok: !!data.success, data };
  } catch (e) {
    console.warn("[CONTACT] Turnstile verify error (failing open):", e.message);
    return { ok: true, degraded: true };
  }
}

// Minimal HTML-escape to keep guest-controlled values safe inside the email body.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * POST /api/contact
 * Body: { name, email, message, turnstileToken? }
 */
router.post("/", async (req, res) => {
  const { name, email, message } = req.body || {};
  const turnstileToken =
    (req.body && (req.body.turnstileToken || req.body["cf-turnstile-response"])) ||
    null;

  // Validate + normalize (strip CR/LF to prevent header injection downstream).
  const cleanName = String(name || "").replace(/[\r\n]+/g, " ").trim();
  const cleanEmail = String(email || "").replace(/[\r\n]+/g, " ").trim();
  const cleanMessage = String(message || "").trim();

  if (!cleanName || !cleanEmail || !cleanMessage) {
    return res
      .status(400)
      .json({ error: "Name, email, and message are required." });
  }
  if (cleanName.length > 120) {
    return res.status(400).json({ error: "Name too long." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }
  if (cleanMessage.length > 5000) {
    return res
      .status(400)
      .json({ error: "Message too long (max 5000 characters)." });
  }

  // Optional bot check (no-op unless TURNSTILE_SECRET is configured).
  const captcha = await verifyTurnstile(turnstileToken, req.ip);
  if (!captcha.ok && TURNSTILE_ENFORCE) {
    return res
      .status(403)
      .json({ error: "Bot verification failed. Please reload and try again." });
  }

  try {
    // Primary sink: persist to Firestore so nothing is lost even without SMTP.
    const docRef = await db.collection("contactMessages").add({
      name: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      status: "new",
      source: "contact-form",
      ip: req.ip || null,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 512) || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Best-effort email notification. Never fail the request on email issues —
    // the submission is already safely stored above.
    const smtpUser =
      process.env.CONTACT_SMTP_USER ||
      process.env.SUPPORT_EMAIL ||
      process.env.BRANCH_SMTP_USER;
    const smtpPass =
      process.env.CONTACT_SMTP_PASS ||
      process.env.SUPPORT_EMAIL_PASSWORD ||
      process.env.BRANCH_SMTP_PASS;
    const recipient =
      process.env.CONTACT_RECIPIENT || process.env.SUPPORT_EMAIL || smtpUser;

    if (smtpUser && smtpPass && recipient) {
      try {
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: smtpUser, pass: smtpPass },
        });
        const safeName = escapeHtml(cleanName);
        const safeEmail = escapeHtml(cleanEmail);
        const safeMessage = escapeHtml(cleanMessage);
        await transporter.sendMail({
          from: `"Magis Website Contact" <${smtpUser}>`,
          to: recipient,
          replyTo: cleanEmail, // sender demoted to reply-to (no open relay)
          subject: `New contact form message from ${cleanName}`,
          text: `Name: ${cleanName}\nEmail: ${cleanEmail}\n\n${cleanMessage}`,
          html:
            `<p><strong>Name:</strong> ${safeName}</p>` +
            `<p><strong>Email:</strong> ${safeEmail}</p>` +
            `<p>${safeMessage.replace(/\n/g, "<br/>")}</p>`,
        });
      } catch (mailErr) {
        console.warn(
          "[CONTACT] stored OK but email notify failed:",
          mailErr?.message || mailErr
        );
      }
    }

    return res.status(200).json({ success: true, id: docRef.id });
  } catch (err) {
    console.error("[CONTACT] ❌ Failed to store message:", err?.message || err);
    return res
      .status(500)
      .json({ error: "Failed to send your message. Please try again." });
  }
});

module.exports = router;
