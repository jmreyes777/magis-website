// routes/guest.js

const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const nodemailer = require("nodemailer");
const { signJWT, verifyJWT } = require("../utils/secretPool"); // worker-backed
const authenticateGuest = require("../middlewares/authenticateGuest");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const { ensureGuestOwns } = require("../middlewares/ensureResourceOwner");
const { requireMFA } = require("../middlewares/requireMFA");

/**
 * Resolve the branch’s staff email (fallback to branchEmail).
 */
async function resolveBranchStaffEmail(branchEmail) {
  const ref = db.collection("branches").doc(branchEmail);
  const doc = await ref.get();
  return doc.exists ? doc.data().staffEmail || branchEmail : branchEmail;
}

/**
 * POST /send-chat-log
 * Send a transcript of the conversation to the branch and guest.
 * Requires a valid guest JWT and ownership of guestId.
 */
router.post(
  "/send-chat-log",
  authenticateGuest,
  ensureGuestOwns,
  async (req, res) => {
    const { guestId, branchEmail, name, email, log } = req.body;

    if (!guestId || !branchEmail || !log) {
      return res
        .status(400)
        .json({ error: "Missing guestId, branchEmail, or log." });
    }

    try {
      const staffEmail = await resolveBranchStaffEmail(branchEmail);

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.SUPPORT_EMAIL,
          pass: process.env.SUPPORT_EMAIL_PASSWORD,
        },
      });

      await transporter.sendMail({
        from: `"Magis Chat" <${process.env.SUPPORT_EMAIL}>`,
        to: staffEmail,
        cc: email,
        subject: `📨 Guest Chat Transcript from ${name || "Anonymous"} (${guestId})`,
        text: log,
        replyTo: email || undefined,
      });

      await db.collection("chatLogs").add({
        guestId,
        branchEmail,
        name,
        email,
        staffEmail,
        log,
        sentAt: new Date(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("[SEND CHAT LOG] ❌", err);
      return res.status(500).json({ error: "Failed to send chat log." });
    }
  }
);

/**
 * POST /init
 * Initialize a new guest session, issue JWT in a Secure, HTTP-only cookie.
 */
router.post("/init", async (req, res) => {
  const { name, email, phone, branchEmail } = req.body;

  if (!name || !branchEmail) {
    return res
      .status(400)
      .json({ error: "Name and branchEmail are required." });
  }

  const guestId = `guest-${Date.now()}`;
  const guestEmail = email || `${guestId}@guest.local`;

  const payload = {
    guestId,
    email: branchEmail.toLowerCase(), // for room mapping
    role: "user",
    fallback: true,
    issuedAt: Date.now(),
  };

  try {
    const token = await signJWT(payload, { expiresIn: "1h" });
    console.log(`[GUEST INIT] ✅ Token issued for guestId: ${guestId}`);

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
 * GET /chat-logs
 * Fetch all transcript logs sent to this branch (staff inbox).
 * Requires a valid branch admin JWT.
 */
router.get("/chat-logs", authenticateBranchAdmin, requireMFA, async (req, res) => {
  const branchEmail = req.branchEmail;
  if (!branchEmail) {
    return res.status(400).json({ error: "Branch email not found in token." });
  }

  try {
    const snap = await db
      .collection("chatLogs")
      .where("branchEmail", "==", branchEmail)
      .orderBy("sentAt", "desc")
      .limit(100)
      .get();

    const logs = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        guestId: d.guestId,
        name: d.name || "Anonymous",
        email: d.email || null,
        log: d.log,
        sentAt: d.sentAt?.toDate?.()?.toISOString() || null,
      };
    });

    return res.status(200).json({ logs });
  } catch (err) {
    console.error("[CHAT LOGS] ❌", err);
    return res.status(500).json({ error: "Failed to fetch chat logs." });
  }
});

/**
 * POST /reply-transcript
 * Staff replies to a guest's transcript thread via email.
 * Authenticated by branch admin JWT.
 */
router.post("/reply-transcript", authenticateBranchAdmin, async (req, res) => {
  const { guestEmail, guestName, replyText } = req.body;
  const branchEmail = req.branchEmail;

  if (!guestEmail || !replyText) {
    return res.status(400).json({ error: "Missing guestEmail or replyText." });
  }

  try {
    const adminSnap = await db.collection("branchAdmins").where("email", "==", branchEmail).limit(1).get();
    const rawName = !adminSnap.empty ? adminSnap.docs[0].data().branchName : null;
    const branchName = rawName ? `Magis Support - ${rawName}` : "Magis Support";

    const smtpUser = process.env.BRANCH_SMTP_USER || process.env.SUPPORT_EMAIL;
    const smtpPass = process.env.BRANCH_SMTP_PASS || process.env.SUPPORT_EMAIL_PASSWORD;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    await transporter.sendMail({
      from: `"${branchName}" <${smtpUser}>`,
      to: guestEmail,
      replyTo: `"${branchName}" <${branchEmail}>`,
      subject: `Re: Your Chat Transcript${guestName ? ` – ${guestName}` : ""}`,
      text: replyText,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[REPLY TRANSCRIPT] ❌", err);
    return res.status(500).json({ error: "Failed to send reply." });
  }
});

/**
 * POST /contact
 * Guest sends a contact form message (with optional image) directly to branch email.
 */
router.post("/contact", async (req, res) => {
  const { branchEmail, branchName, guestEmail, message, imageBase64, imageName } = req.body;
  if (!branchEmail || !guestEmail || !message) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    const smtpUser = process.env.BRANCH_SMTP_USER || process.env.SUPPORT_EMAIL;
    const smtpPass = process.env.BRANCH_SMTP_PASS || process.env.SUPPORT_EMAIL_PASSWORD;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: smtpUser, pass: smtpPass },
    });

    const adminSnap = await db.collection("branchAdmins").where("email", "==", branchEmail).limit(1).get();
    const rawName = !adminSnap.empty ? adminSnap.docs[0].data().branchName : null;
    const displayName = rawName ? `Magis Support - ${rawName}` : (branchName || "Magis Support");

    const mailOptions = {
      from: `"${displayName}" <${smtpUser}>`,
      to: [branchEmail, guestEmail],
      replyTo: guestEmail,
      subject: `New Contact Form Message from ${guestEmail}`,
      text: `From: ${guestEmail}\n\n${message}`,
      html: `<p><strong>From:</strong> ${guestEmail}</p><p>${message.replace(/\n/g, "<br/>")}</p>`,
      attachments: imageBase64 ? [{
        filename: imageName || "attachment.jpg",
        content: imageBase64.split(",")[1] || imageBase64,
        encoding: "base64",
      }] : [],
    };

    await transporter.sendMail(mailOptions);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[CONTACT] ❌", err);
    return res.status(500).json({ error: "Failed to send message." });
  }
});

/**
 * POST /pending-inquiry
 * Save an out-of-hours guest message to Firestore for staff follow-up.
 */
router.post("/pending-inquiry", async (req, res) => {
  const { branchEmail, branchName, guestName, guestEmail, message } = req.body;
  if (!branchEmail || !guestName || !guestEmail || !message) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    await db.collection("pendingInquiries").add({
      branchEmail,
      branchName: branchName || "Magis Support",
      guestName,
      guestEmail,
      message,
      status: "unread",
      createdAt: new Date().toISOString(),
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[PENDING INQUIRY] ❌", err);
    return res.status(500).json({ error: "Failed to save inquiry." });
  }
});

/**
 * GET /pending-inquiries
 * Fetch all pending inquiries for the authenticated branch admin.
 */
router.get("/pending-inquiries", authenticateBranchAdmin, requireMFA, async (req, res) => {
  const branchEmail = req.branchEmail;
  try {
    const snap = await db.collection("pendingInquiries")
      .where("branchEmail", "==", branchEmail)
      .orderBy("createdAt", "desc")
      .get();
    const inquiries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ inquiries });
  } catch (err) {
    console.error("[PENDING INQUIRIES] ❌", err);
    return res.status(500).json({ error: "Failed to fetch inquiries." });
  }
});

/**
 * PATCH /pending-inquiries/:id/read
 * Mark an inquiry as read.
 */
router.patch("/pending-inquiries/:id/read", authenticateBranchAdmin, async (req, res) => {
  try {
    await db.collection("pendingInquiries").doc(req.params.id).update({ status: "read" });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update inquiry." });
  }
});

/**
 * POST /refresh-token
 * Re-issue JWT in a Secure, HTTP-only cookie for an existing guest.
 */
router.post("/refresh-token", async (req, res) => {
  const { guestId, branchEmail } = req.body;
   console.log(
   `[GUEST REFRESH] 🔄 Received refresh-token request for guestId=${guestId} branchEmail=${branchEmail} at ${new Date().toISOString()}`
 );
  if (!guestId || !branchEmail) {
    return res
      .status(400)
      .json({ error: "guestId and branchEmail are required" });
  }

  const payload = {
    guestId,
    email: branchEmail.toLowerCase(),
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
      .json({ token });

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

module.exports = router;
