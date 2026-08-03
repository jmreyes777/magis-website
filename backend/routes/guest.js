// routes/guest.js

const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const nodemailer = require("nodemailer");
const { signJWT, verifyJWT } = require("../utils/secretPool"); // worker-backed
const { verifyLocal } = require("../utils/jwtKeys"); // alg-aware direct verify of prior guest token (P1-4, P2-3)
const { v4: uuidv4 } = require("uuid");       // unguessable guest ids (P1-4)
const authenticateGuest = require("../middlewares/authenticateGuest");
const { ensureGuestOwns } = require("../middlewares/ensureResourceOwner");
const { recordAuditEvent, auditContextFromReq, maskEmail, ACTIONS } = require("../utils/auditLog");

// P1-4 (Part B): Cloudflare Turnstile verification for the public /init endpoint.
// Enforced ONLY when TURNSTILE_SECRET is configured (graceful no-op otherwise).
// On verifier outage we fail OPEN (the per-IP rate-limit on /init still applies).
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";
// Set TURNSTILE_ENFORCE=false to run in MONITOR mode (verify + log, do NOT block)
// — useful while validating the widget/hostname setup. Default: enforce.
const TURNSTILE_ENFORCE = process.env.TURNSTILE_ENFORCE !== "false";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// SPD4-2 (speed megaplan): bound the external verify call. Baseline showed the
// Turnstile round-trip dominates guest-init latency; an unbounded slow verify
// (verifier brown-out) previously hung the whole request. On timeout we take
// the SAME fail-open path as a verifier outage (rate-limit still applies), so
// the security posture is unchanged — only the tail latency is now bounded.
const TURNSTILE_TIMEOUT_MS = Number(process.env.TURNSTILE_TIMEOUT_MS) || 3000;
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
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    const data = await r.json();
    return { ok: !!data.success, data };
  } catch (e) {
    console.warn("[GUEST INIT] Turnstile verify error (failing open):", e.message);
    return { ok: true, degraded: true };
  }
}

/**
 * Resolve the branch’s staff email (fallback to branchEmail).
 */
async function resolveBranchStaffEmail(branchEmail) {
  const ref = db.collection("branches").doc(branchEmail);
  const doc = await ref.get();
  return doc.exists ? doc.data().staffEmail || branchEmail : branchEmail;
}

/**
 * Minimal HTML-escape to prevent injection in email bodies (P1-5).
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * POST /init
 * Initialize a new guest session, issue JWT in a Secure, HTTP-only cookie.
 */
router.post("/init", async (req, res) => {
  const t0 = Date.now();
  const { name, email, phone, branchEmail } = req.body;

  if (!name || !branchEmail) {
    return res
      .status(400)
      .json({ error: "Name and branchEmail are required." });
  }

  // P1-4: unguessable, non-enumerable guest id (was `guest-${Date.now()}`).
  const guestId = `guest-${uuidv4()}`;
  const guestEmail = email || `${guestId}@guest.local`;

  const payload = {
    guestId,
    email: branchEmail.toLowerCase(), // for room mapping
    role: "user",
    fallback: true,
    issuedAt: Date.now(),
  };

  // SPD4-2 (speed megaplan): the JWT sign and the Turnstile verify are
  // independent — start the sign while the (network-bound) verify runs.
  // ENFORCEMENT ORDER IS UNCHANGED: the signed token is only *used* after the
  // captcha gate passes below; on a 403 it is discarded (never delivered, no
  // revocation state exists at sign time). Result wrapper avoids an unhandled
  // rejection if the sign fails while the captcha path returns early.
  const signPromise = signJWT(payload, { expiresIn: "1h" }).then(
    (token) => ({ token }),
    (err) => ({ err })
  );

  // P1-4 (Part B): bot check — no-op until TURNSTILE_SECRET is configured.
  const turnstileToken =
    req.body.turnstileToken || req.body["cf-turnstile-response"] || null;
  const captcha = await verifyTurnstile(turnstileToken, req.ip);
  const tCaptcha = Date.now();
  if (!captcha.ok) {
    console.warn(`[GUEST INIT] ${TURNSTILE_ENFORCE ? "🚫 BLOCK" : "👀 monitor"} Turnstile (${captcha.reason || "verify-failed"}) ip=${req.ip}`);
    if (TURNSTILE_ENFORCE) {
      return res.status(403).json({ error: "Bot verification failed. Please reload and try again." });
    }
  }

  try {
    const signed = await signPromise;
    if (signed.err) throw signed.err;
    const token = signed.token;
    // SPD4-2: timing evidence — turnstile RTT vs total handler time.
    console.log(
      `[GUEST INIT] ✅ Token issued for guestId: ${guestId} ` +
      `(turnstile=${tCaptcha - t0}ms total=${Date.now() - t0}ms)`
    );

    // Audit: a new guest chat session started (best-effort, PII-minimized).
    recordAuditEvent({
      category: "chat",
      action: ACTIONS.CHAT_SESSION_START,
      severity: "info",
      actor: { type: "guest", id: guestId },
      branchEmail: String(branchEmail).toLowerCase(),
      target: { type: "guest_session", id: guestId, guestId },
      context: auditContextFromReq(req),
      meta: {
        providedEmail: !!email,
        providedPhone: !!phone,
        turnstile: captcha.skipped ? "skipped" : captcha.ok ? "passed" : "failed",
      },
    });

    // Build a Partitioned, cross-site cookie
    const guestCookie = [
      `guestToken=${token}`,
      `Path=/`,
      `HttpOnly`,
      `Secure`,
      `SameSite=None`,      // allow cross-site
      `Partitioned`,        // opt into partitioned cookie model
      `Max-Age=${60 * 60}`, // 10 minutes - revert to 1 hour -> 60x60
    ].join("; ");

    res
      .setHeader("Set-Cookie", guestCookie)
      .status(200)
      .json({ guestId, token });

  } catch (err) {
    console.error("[GUEST INIT] ❌ Failed to sign token:", err.message);
    console.error("[GUEST INIT] Error stack:", err.stack);
    return res
      .status(500)
      .json({ error: "Failed to initialize guest session.", details: err.message });
  }
});

/**
 * POST /contact
 * Guest sends a contact form message (with optional image) directly to branch email.
 */
// P1-5: require a valid guest session (authenticateGuest). Per-IP rate-limit is
// applied at the app level in server.js (guestContactLimiter).
router.post("/contact", authenticateGuest, async (req, res) => {
  const { branchEmail, branchName, guestEmail, message, imageBase64, imageName } = req.body;
  if (!branchEmail || !guestEmail || !message) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  // P1-5: validate the guest-supplied address — strip CR/LF (mail-header
  // injection) and require a plausible email so replyTo/subject stay clean.
  const cleanGuestEmail = String(guestEmail).replace(/[\r\n]+/g, " ").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanGuestEmail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }
  if (String(message).length > 5000) {
    return res.status(400).json({ error: "Message too long." });
  }

  try {
    // P1-5: only deliver to a REAL branch, resolved SERVER-SIDE. The guest's
    // email is demoted to reply-to (never a recipient), so this endpoint can't
    // be abused as an open relay to arbitrary addresses.
    const adminSnap = await db.collection("branchAdmins").where("email", "==", branchEmail).limit(1).get();
    if (adminSnap.empty) {
      return res.status(404).json({ error: "Unknown branch." });
    }
    const rawName = adminSnap.docs[0].data().branchName || branchName || null;
    const displayName = rawName ? `Magis Support - ${rawName}` : "Magis Support";
    const recipient = await resolveBranchStaffEmail(branchEmail);

    const smtpUser = process.env.BRANCH_SMTP_USER || process.env.SUPPORT_EMAIL;
    const smtpPass = process.env.BRANCH_SMTP_PASS || process.env.SUPPORT_EMAIL_PASSWORD;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: smtpUser, pass: smtpPass },
    });

    // P1-5: escape guest-controlled values before interpolating into HTML.
    const safeEmail = escapeHtml(cleanGuestEmail);
    const safeMessage = escapeHtml(String(message));
    const mailOptions = {
      from: `"${displayName}" <${smtpUser}>`,
      to: recipient,
      replyTo: cleanGuestEmail,
      subject: `New Contact Form Message from ${cleanGuestEmail}`,
      text: `From: ${cleanGuestEmail}\n\n${String(message)}`,
      html: `<p><strong>From:</strong> ${safeEmail}</p><p>${safeMessage.replace(/\n/g, "<br/>")}</p>`,
      attachments: imageBase64 ? [{
        filename: imageName || "attachment.jpg",
        content: imageBase64.split(",")[1] || imageBase64,
        encoding: "base64",
      }] : [],
    };

    await transporter.sendMail(mailOptions);

    // Audit: a transcript/contact message was relayed to the branch. The guest
    // email is MASKED; the message body is never stored.
    recordAuditEvent({
      category: "chat",
      action: ACTIONS.CHAT_TRANSCRIPT_EMAILED,
      severity: "notice",
      actor: { type: "guest" },
      branchEmail: String(branchEmail).toLowerCase(),
      target: { type: "branch_contact" },
      context: auditContextFromReq(req),
      meta: {
        guestEmail: maskEmail(cleanGuestEmail),
        hasAttachment: !!imageBase64,
        messageLength: String(message).length,
      },
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[CONTACT] ❌", err);
    return res.status(500).json({ error: "Failed to send message." });
  }
});

/**
 * POST /refresh-token
 * Re-issue JWT in a Secure, HTTP-only cookie for an existing guest.
 */
// P1-4: a refresh may re-issue a token only for the holder of a token we
// previously signed. A recently-expired token is still accepted (refresh often
// fires around expiry); beyond this grace window the guest must start anew.
const GUEST_REFRESH_GRACE_MS =
  Number(process.env.GUEST_REFRESH_GRACE_MS) || 30 * 24 * 60 * 60 * 1000; // 30 days

router.post("/refresh-token", async (req, res) => {
  // SECURITY (P1-4): require proof. The caller must present a guest token we
  // issued — via the HttpOnly `guestToken` cookie, an `Authorization: Bearer`
  // header, or `body.token`. The new token is minted strictly for the identity
  // inside that verified token; client-supplied guestId/branchEmail are ignored.
  const bearer =
    typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : null;
  const priorToken =
    (req.cookies && req.cookies.guestToken) || bearer || (req.body && req.body.token) || null;

  if (!priorToken) {
    return res.status(401).json({ error: "A prior guest token is required to refresh." });
  }

  let claims;
  try {
    // P2-3: verify with whatever algorithm the token actually uses (RS256 via
    // public key or HS256 via secret) instead of assuming HS256 + symmetric key.
    claims = verifyLocal(priorToken, {
      ignoreExpiration: true, // recently-expired allowed; bounded by grace below
    });
  } catch (e) {
    return res.status(401).json({ error: "Invalid guest token." });
  }

  if (!claims || claims.role !== "user" || !claims.guestId || !claims.email) {
    return res.status(401).json({ error: "Not a valid guest token." });
  }
  if (claims.exp && Date.now() > claims.exp * 1000 + GUEST_REFRESH_GRACE_MS) {
    return res.status(401).json({ error: "Guest token too old to refresh; start a new session." });
  }

  const guestId = claims.guestId;
  console.log(
    `[GUEST REFRESH] 🔄 Verified refresh for guestId=${guestId} at ${new Date().toISOString()}`
  );

  const payload = {
    guestId,
    email: claims.email, // branch email for room mapping, taken from the verified token
    role: "user",
    fallback: true,
  };

  try {
    const token = await signJWT(payload, { expiresIn: "1h" });
    console.log(`[GUEST REFRESH] ✅ Token refreshed for ${guestId}`);

    // Build a Partitioned, cross-site cookie
    const guestCookie = [
      `guestToken=${token}`,
      `Path=/`,
      `HttpOnly`,
      `Secure`,
      `SameSite=None`,      // allow cross-site
      `Partitioned`,        // opt into partitioned cookie model
      `Max-Age=${60 * 60}`, // 1 hour in seconds
    ].join("; ");

    res
      .setHeader("Set-Cookie", guestCookie)
      .status(200)
      .json({ token, guestId });

  } catch (err) {
    console.error("[GUEST REFRESH] ❌", err);
    return res.status(500).json({ error: "Failed to refresh token." });
  }
});

/**
 * POST /force-close
 * Archive and close a guest’s chat.
 * Requires a valid guest JWT and ownership of guestId.
 */
router.post(
  "/force-close",
  authenticateGuest,
  ensureGuestOwns,
  async (req, res) => {
    const { guestId, branchEmail } = req.body;
    if (!guestId || !branchEmail) {
      return res
        .status(400)
        .json({ error: "Missing guestId or branchEmail." });
    }

    try {
      const messagesRef = db.collection("messages");
      const snapshot = await messagesRef
        .where("guestId", "==", guestId)
        .where("branchEmail", "==", branchEmail)
        .get();

      if (snapshot.empty) {
        console.warn(`[FORCE-CLOSE] ⚠️ No messages for ${guestId} — proceeding to close anyway.`);
      } else {
        // archive existing messages
        const batch = db.batch();
        snapshot.forEach((doc) => batch.update(doc.ref, { archived: true }));
        await batch.commit();
      }

      const batch = db.batch();
      snapshot.forEach((doc) => batch.update(doc.ref, { archived: true }));
      await batch.commit();

      // Emit chatClosed to admins via Socket.IO if available
      const io = req.app.get("socketio");
      if (io) {
        io.to(`admin-${branchEmail}`).emit("chatClosed", { guestId });
        console.log(
          `[FORCE-CLOSE] 📣 chatClosed ➡️ admin-${branchEmail}`
        );
      }

      // Audit: guest-initiated chat close + archive (best-effort).
      recordAuditEvent({
        category: "chat",
        action: ACTIONS.CHAT_CLOSED,
        severity: "info",
        actor: { type: "guest", id: guestId },
        branchEmail: String(branchEmail).toLowerCase(),
        target: { type: "conversation", guestId },
        context: auditContextFromReq(req),
        meta: { reason: "guest_force_close", archivedCount: snapshot.size || 0 },
      });

      return res
        .status(200)
        .json({ success: true, archivedCount: snapshot.size || 0 });
    } catch (err) {
      console.error("[FORCE-CLOSE] ❌ Error processing force-close:", err);
      return res
        .status(500)
        .json({ error: "Internal server error" });
    }
  }
);

/**
 * POST /guest/csat
 * Body: { guestId, branchEmail, rating: 1..5 }
 *
 * CHATUX2: optional post-chat satisfaction rating. Strictly voluntary — the
 * guest UI only offers it after a conversation with at least one staff reply
 * and under a long client-side cooldown (see user-frontend/src/utils/csat.js);
 * this endpoint just validates + records.
 *
 * Requires a valid guest JWT + guestId ownership (same stack as /force-close),
 * so ratings can't be stuffed anonymously. Idempotent per conversation-day:
 * the doc id is guest+branch+day, so re-rating overwrites instead of double
 * counting. Docs expire via TTL (CSAT_RETENTION_DAYS, default 365).
 */
router.post("/csat", authenticateGuest, ensureGuestOwns, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { guestId, branchEmail } = req.body || {};
  const rating = Number(req.body?.rating);

  if (!guestId || !branchEmail) {
    return res.status(400).json({ error: "Missing guestId or branchEmail." });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be an integer 1-5." });
  }

  try {
    const branch = String(branchEmail).toLowerCase().slice(0, 120);
    const retentionDays = Math.max(parseInt(process.env.CSAT_RETENTION_DAYS, 10) || 365, 1);
    // Asia/Manila day key — matches the RUM rollup convention (routes/rum.js).
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    const docId = `${guestId}__${branch}__${day}`.slice(0, 400);

    await db.collection("csatRatings").doc(docId).set({
      guestId,
      branchEmail: branch,
      rating,
      day,
      at: new Date().toISOString(),
      expireAt: new Date(Date.now() + retentionDays * 86400_000),
    });

    // Structured log line so ratings are greppable on the Render stream even
    // before any dashboard surfaces them.
    console.log(JSON.stringify({ t: "csat", branch, rating, day }));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[CSAT] ❌ Error recording rating:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
