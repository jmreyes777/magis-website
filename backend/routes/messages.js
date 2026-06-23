// routes/messages.js

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { db } = require("../utils/firebase");
const { getSocketIOInstance } = require("../utils/socket");
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin");
const { z } = require("zod");
const multer = require("multer");
const authenticateGuest       = require("../middlewares/authenticateGuest");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const authenticateSuperAdmin  = require("../middlewares/authenticateSuperAdmin");
const {
  ensureGuestOwns,
  ensureBranchOwns,
} = require("../middlewares/ensureResourceOwner");
const rateLimitByGuest       = require("../middlewares/rateLimitByGuest");
const { requireMFA }          = require("../middlewares/requireMFA");
const { recordAuditEvent, ACTIONS } = require("../utils/auditLog");
// const sharp = require("sharp"); // Removed due to Node.js 24 compatibility issues

// Multer setup: memory storage, 5 MB limit, only images/PDFs
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/gif", "application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("File type not allowed"), false);
  },
});

// Socket.io and storage bucket
const io = getSocketIOInstance();
const bucket = admin.storage().bucket();

// Upload a buffer to Cloud Storage as a PRIVATE object (P1-3). Returns the
// storage path (object name). Callers store the path on the message; media is
// served on demand via short-lived signed URLs from the resolver endpoints.
async function uploadMediaToStorage(buffer, fileName, contentType) {
  const file = bucket.file(fileName);
  await file.save(buffer, contentType ? { metadata: { contentType } } : undefined);
  return fileName;
}

// Short-lived V4 signed URL for a stored media object path. The Firebase Admin
// service-account key signs locally (no extra IAM/SignBlob permission needed).
const MEDIA_SIGNED_URL_TTL_MS = Number(process.env.MEDIA_SIGNED_URL_TTL_MS) || 15 * 60 * 1000;
async function signMediaPath(path) {
  const [url] = await bucket.file(path).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + MEDIA_SIGNED_URL_TTL_MS,
  });
  return url;
}

// Build a signed media payload from a message's stored `media`. Legacy docs that
// still carry a full public URL are passed through unchanged (pre-migration).
async function signMessageMedia(media) {
  if (!media) return null;
  if (typeof media.url === "string" && /^https?:\/\//i.test(media.url)) {
    return {
      type: media.type,
      url: media.url,
      src: media.src || media.url,
      ...(media.srcSet ? { srcSet: media.srcSet } : {}),
    };
  }
  if (Array.isArray(media.paths) && media.paths.length) {
    const signed = await Promise.all(
      media.paths.map(async (p) => ({ width: p.width, url: await signMediaPath(p.path) }))
    );
    signed.sort((a, b) => a.width - b.width);
    const best = signed[signed.length - 1].url;
    return {
      type: media.type,
      url: best,
      src: best,
      srcSet: signed.map((p) => `${p.url} ${p.width}w`).join(", "),
    };
  }
  if (!media.path) return null;
  const url = await signMediaPath(media.path);
  return { type: media.type, url, src: url, ...(media.name ? { name: media.name } : {}) };
}

// Normalize room name based on role
function getRoomName(role, id) {
  const prefix = role === "admin" || role === "branchadmin" ? "admin" : "guest";
  return `${prefix}-${id}`;
}

// ============================================================================
// CONVERSATION KEY STORE (E2EE with managed keys)
// ----------------------------------------------------------------------------
// A single AES-256 key per (branch, guest) conversation. Both the guest and the
// branch admin fetch the SAME key (over an authenticated, TLS + edge-protected
// channel) and use it with the existing AES-256-GCM message format. Unlike the
// previous ephemeral ECDH handshake, this lets the admin read history even when
// the guest is offline. The key is stored encrypted-at-rest in Firestore when
// CONV_KEY_SECRET is configured, and access is gated by per-side auth + ACL.
// ============================================================================
const CONV_KEY_SECRET = process.env.CONV_KEY_SECRET || "";

const normGuestKeyId = (s = "") =>
  String(s).toLowerCase().replace(/^guest-/, "").trim();
const normEmailKeyId = (s = "") => String(s).toLowerCase().trim();

function deriveMasterKey() {
  if (!CONV_KEY_SECRET) return null;
  return crypto.createHash("sha256").update(CONV_KEY_SECRET).digest(); // 32 bytes
}

// Wrap the raw conversation key for at-rest storage. Falls back to storing raw
// (with a one-time warning) if no CONV_KEY_SECRET is configured.
function wrapConversationKey(rawB64) {
  const master = deriveMasterKey();
  if (!master) {
    if (!wrapConversationKey._warned) {
      console.warn(
        "[CONV-KEY] ⚠️ CONV_KEY_SECRET not set — conversation keys stored unwrapped. Set CONV_KEY_SECRET for encryption-at-rest."
      );
      wrapConversationKey._warned = true;
    }
    return rawB64;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", master, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(rawB64, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function unwrapConversationKey(stored) {
  if (!stored || !String(stored).startsWith("v1:")) return stored; // raw
  const master = deriveMasterKey();
  if (!master) throw new Error("CONV_KEY_SECRET required to read wrapped conversation key");
  const [, ivB64, tagB64, encB64] = String(stored).split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    master,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

// Get the conversation key, creating it atomically on first request so the
// guest and admin always converge on the same key regardless of who asks first.
async function getOrCreateConversationKey(branchEmail, guestId) {
  const branch = normEmailKeyId(branchEmail);
  const guest = normGuestKeyId(guestId);
  const docId = `${branch}__${guest}`;
  const ref = db.collection("conversationKeys").doc(docId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      return unwrapConversationKey(snap.data().key);
    }
    const rawB64 = crypto.randomBytes(32).toString("base64"); // AES-256
    tx.set(ref, {
      key: wrapConversationKey(rawB64),
      branchEmail: branch,
      guestId: guest,
      createdAt: new Date().toISOString(),
    });
    return rawB64;
  });
}

// ============================================================================
// SENSITIVE DATA REDACTION
// ============================================================================
const SENSITIVE_PATTERNS = [
  { name: 'Credit Card', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/, mask: '****-****-****-****' },
  { name: 'Bank Account', regex: /\b\d{10,16}\b/, maskFn: (m) => m.slice(0, 4) + '****' + m.slice(-4) },
  { name: 'Password', regex: /password[:=\s]+\S+/gi, mask: 'password: [REDACTED]' },
  { name: 'PIN', regex: /\bPIN\s*[:=]?\s*\d{4,6}\b/gi, mask: 'PIN: [REDACTED]' },
  { name: 'API Key', regex: /(?:api[_-]?key|token|secret)[:=\s]+[a-zA-Z0-9]{16,}/gi, mask: '[API-KEY-REDACTED]' },
  
  // Philippine phone numbers - mobile, landline, trunk
  { name: 'PH Mobile', regex: /\b(?:\+63|0)9\d{9}\b/g, mask: '[MOBILE-REDACTED]' },
  { name: 'PH Landline', regex: /\b(?:\+63|0)?\(?0?2\)?[-.\s]?\d{7,8}\b/g, mask: '[LANDLINE-REDACTED]' },
  { name: 'PH Trunk Line', regex: /\b\d{3}[-.\s]?\d{4}\b/g, mask: '[EXTENSION-REDACTED]' },
  
  // Pawnshop specific - Pawn Ticket Numbers (alphanumeric, varying formats)
  { name: 'Pawn Ticket', regex: /\b(?:ptn|pt|pkt|ticket|tkt|sangla|sgl|pawn|p)[-#:\s]*[A-Z0-9]{4,15}\b/gi, mask: '[PAWNTICKET-REDACTED]' },
  { name: 'Item Value', regex: /\b(?:value|amount|appraisal)[\s:]*[\d,]+(?:\.\d{2})?\b/gi, mask: '[VALUE-REDACTED]' },
  
  // ============================================================================
  // PHILIPPINE GOVERNMENT IDs - Comprehensive Coverage
  // ============================================================================
  
  // SSS Number - 10 digits, various formats
  { name: 'SSS Number', regex: /\b(?:sss#?|sss\s*(?:no|number|id)?)[:\s-]*\d{2}?[-]?\d{7}[-]?\d{1}?\b/gi, mask: '[SSS-REDACTED]' },
  { name: 'SSS Number (10 digit)', regex: /\b\d{10}\b(?![\d-])/g, mask: '[ID-REDACTED]' },
  
  // GSIS ID - 11 digits or BP prefix
  { name: 'GSIS ID', regex: /\b(?:gsis#?|gsis\s*(?:no|number|id)?)[:\s-]*(?:bp)?\d{8,11}\b/gi, mask: '[GSIS-REDACTED]' },
  { name: 'GSIS ID (BP)', regex: /\bBP\d{8,11}\b/gi, mask: '[GSIS-REDACTED]' },
  
  // TIN - Tax Identification Number (9-12 digits)
  { name: 'TIN', regex: /\b(?:tin#?|tin\s*(?:no|number|id)?)[:\s-]*\d{3}[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{0,3}\b/gi, mask: '[TIN-REDACTED]' },
  { name: 'TIN (9-12 digit)', regex: /\b\d{3}[-\s]\d{3}[-\s]\d{3}(?:[-\s]\d{3})?\b/g, mask: '[TIN-REDACTED]' },
  
  // PhilHealth - 12 digits (NNNN-NNNNNNNN-N)
  { name: 'PhilHealth', regex: /\b(?:philhealth|ph|phic)[#:\s-]*\d{4}[-\s]?\d{8,9}[-\s]?\d?\b/gi, mask: '[PHILHEALTH-REDACTED]' },
  { name: 'PhilHealth (12 digit)', regex: /\b\d{4}[-\s]\d{8}[-\s]\d\b/g, mask: '[PHILHEALTH-REDACTED]' },
  
  // PAG-IBIG / HDMF - 12 digits
  { name: 'PAG-IBIG', regex: /\b(?:pag-?ibig|hdmf|mid)[#:\s-]*\d{12}\b/gi, mask: '[PAGIBIG-REDACTED]' },
  { name: 'PAG-IBIG (12 digit)', regex: /\b\d{12}\b(?=[^\d-]|$)/g, mask: '[ID-REDACTED]' },
  
  // UMID - Unified Multi-purpose ID
  { name: 'UMID', regex: /\b(?:umid|sss-umid|gsis-umid)[#:\s-]*[A-Z]{2,4}[-\s]?\d{10,12}\b/gi, mask: '[UMID-REDACTED]' },
  
  // Driver's License - Various formats
  { name: 'Driver\'s License', regex: /\b(?:dl|license)[#:\s-]*[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{5,6}\b/gi, mask: '[DRIVERLICENSE-REDACTED]' },
  { name: 'Driver\'s License (N)', regex: /\bN\d{2}[-\s]?\d{2}[-\s]?\d{5,6}\b/g, mask: '[DRIVERLICENSE-REDACTED]' },
  { name: 'Driver\'s License (New)', regex: /\b[A-Z]\d{10}\b/g, mask: '[DRIVERLICENSE-REDACTED]' },
  
  // Passport - 9 alphanumeric
  { name: 'Passport', regex: /\b(?:passport|pp)[#:\s-]*[A-Z]{1,2}\d{6,7}[A-Z]?\b/gi, mask: '[PASSPORT-REDACTED]' },
  { name: 'Passport (9 char)', regex: /\b[A-Z]\d{7}[A-Z]?\b|\b[A-Z]{2}\d{6}\b/g, mask: '[PASSPORT-REDACTED]' },
  
  // PRC License - 7 digits
  { name: 'PRC License', regex: /\b(?:prc)[#:\s-]*\d{7}\b/gi, mask: '[PRC-REDACTED]' },
  { name: 'PRC (7 digit)', regex: /\b\d{7}\b(?![\d])/g, mask: '[PRC-REDACTED]' },
  
  // Voter's ID (COMELEC) - 18 digits
  { name: 'Voter\'s ID', regex: /\b(?:voter|comelec|voter's)[#:\s-]*\d{18,20}\b/gi, mask: '[VOTERID-REDACTED]' },
  { name: 'Voter ID (18+ digit)', regex: /\b\d{18,20}\b/g, mask: '[VOTERID-REDACTED]' },
  
  // Postal ID - 10+ digits
  { name: 'Postal ID', regex: /\b(?:postal|pid)[#:\s-]*\d{10,16}\b/gi, mask: '[POSTALID-REDACTED]' },
  
  // NBI Clearance
  { name: 'NBI Clearance', regex: /\b(?:nbi)[#:\s-]*[A-Z]?\d{8,12}\b/gi, mask: '[NBI-REDACTED]' },
  
  // Police Clearance
  { name: 'Police Clearance', regex: /\b(?:police|pc)[#:\s-]*[A-Z]{2,3}[-\s]?\d{5,8}\b/gi, mask: '[POLICE-REDACTED]' },
  
  // Barangay ID
  { name: 'Barangay ID', regex: /\b(?:brgy|barangay)[#:\s-]*\d{6,10}\b/gi, mask: '[BARANGAYID-REDACTED]' },
  
  // Senior Citizen ID
  { name: 'Senior Citizen ID', regex: /\b(?:senior|sc)[#:\s-]*(?:sc)?[-\s]?\d{4}[-\s]?\d{6,8}\b/gi, mask: '[SENIORID-REDACTED]' },
  { name: 'Senior Citizen (OSCA)', regex: /\bOSCA[-\s]?\d{4}[-\s]?\d{6}\b/gi, mask: '[SENIORID-REDACTED]' },
  
  // PWD ID
  { name: 'PWD ID', regex: /\b(?:pwd)[#:\s-]*[A-Z]{2,3}[-\s]?\d{6,8}\b/gi, mask: '[PWDID-REDACTED]' },
  
  // OFW ID / OWWA
  { name: 'OFW ID', regex: /\b(?:ofw|owwa)[#:\s-]*\d{9,12}\b/gi, mask: '[OFWID-REDACTED]' },
  
  // 4Ps ID (DSWD)
  { name: '4Ps ID', regex: /\b(?:4ps|hh)[#:\s-]*\d{10,12}\b/gi, mask: '[4PSID-REDACTED]' },
  
  // Seaman's Book
  { name: 'Seaman\'s Book', regex: /\b(?:seaman|sb)[#:\s-]*[A-Z]?\d{6,10}\b/gi, mask: '[SEAMANBOOK-REDACTED]' },
  { name: 'Seaman\'s Book (S)', regex: /\bS\d{7}\b/g, mask: '[SEAMANBOOK-REDACTED]' },
  
  // Military/Police IDs
  { name: 'AFP ID', regex: /\b(?:afp)[#:\s-]*\d{7,10}\b/gi, mask: '[AFPID-REDACTED]' },
  { name: 'PNP ID', regex: /\b(?:pnp)[#:\s-]*\d{6,8}\b/gi, mask: '[PNPID-REDACTED]' },
  
  // IBP (Lawyer)
  { name: 'IBP Roll', regex: /\b(?:ibp)[#:\s-]*\d{5,7}\b/gi, mask: '[IBP-REDACTED]' },
  
  // BALIK MANGGAGAWA
  { name: 'Balik Manggagawa', regex: /\b(?:bm|balik)[#:\s-]*\d{9,12}\b/gi, mask: '[BALIKMANGGAGAWA-REDACTED]' },
  
  // Private/Company IDs
  { name: 'Company ID', regex: /\b(?:emp|employee|staff|id#)[#:\s-]*\d{5,10}\b/gi, mask: '[EMPLOYEEID-REDACTED]' },
  { name: 'Student ID', regex: /\b(?:student|sch|school)[#:\s-]*\d{4}[-\s]?\d{4,6}\b/gi, mask: '[STUDENTID-REDACTED]' },
  
  // Insurance & Financial
  { name: 'Insurance Policy', regex: /\b(?:pl|policy|ins)[#:\s-]*[A-Z]{2,4}[-\s]?\d{6,10}\b/gi, mask: '[POLICY-REDACTED]' },
  { name: 'Membership ID', regex: /\b(?:mem|member|vip)[#:\s-]*\d{4}[-\s]?\d{4,6}\b/gi, mask: '[MEMBERID-REDACTED]' },
];

function redactSensitiveData(content) {
  if (!content || typeof content !== 'string') return content;
  
  let redacted = content;
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.maskFn) {
      redacted = redacted.replace(pattern.regex, pattern.maskFn);
    } else {
      redacted = redacted.replace(pattern.regex, pattern.mask);
    }
  }
  return redacted;
}

function detectSensitivePatterns(content) {
  if (!content || typeof content !== 'string') return [];
  return SENSITIVE_PATTERNS.filter(p => p.regex.test(content)).map(p => p.name);
}

// Audit log for messages with sensitive data (stores original in encrypted-like format)
async function logSensitiveMessage(messageId, originalContent, patterns, guestId, branchEmail) {
  try {
    await db.collection('sensitiveMessageAudit').add({
      messageId,
      patterns,
      guestId,
      branchEmail,
      timestamp: new Date().toISOString(),
      // Note: In production, encrypt originalContent before storing
      // For now, we just log that sensitive data was detected
      hasSensitiveData: true,
    });
  } catch (e) {
    console.warn('[AUDIT] Failed to log sensitive message:', e.message);
  }

  // Bridge into the unified audit trail (best-effort, PII-minimized: only the
  // detected pattern TYPES are recorded — never the message content).
  recordAuditEvent({
    category: "chat",
    action: ACTIONS.CHAT_SENSITIVE_DETECTED,
    severity: "warning",
    actor: { type: "guest", id: guestId },
    branchEmail,
    target: { type: "message", id: messageId, guestId },
    meta: { patterns, patternCount: Array.isArray(patterns) ? patterns.length : 0 },
  });
}

// 1) Helper that only calls multer for multipart/form-data
function optionalMediaUpload(req, res, next) {
  if (req.is("multipart/form-data")) {
    return upload.single("media")(req, res, next);
  }
  next();
}

// If tempId matches an optimistic draft, update it
async function tryUpdateOptimisticMessage(tempId, data) {
  if (!tempId) return null;
  const snap = await db
    .collection("messages")
    .where("tempId", "==", tempId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const ref = snap.docs[0].ref;
  await ref.update(data);
  const fresh = await ref.get();
  return { id: ref.id, ...fresh.data() };
}

// NEW: Idempotent save using a deterministic document id (clientMessageId).
// If a doc with that id already exists, return it (do not create a duplicate).
async function saveIdempotentMessage(docId, data) {
  const ref = db.collection("messages").doc(docId);
  const existing = await ref.get();
  if (existing.exists) {
    return { id: ref.id, ...existing.data() };
  }
  await ref.set(data, { merge: false });
  return { id: ref.id, ...data };
}

/**
 * POST /api/messages/start
 * Guest initiates a new chat session.
 */
router.post("/start", authenticateGuest, async (req, res) => {
  // P2-5: require a valid guest token. The guest IDENTITY (guestId + branch)
  // comes from the verified token — never trusted from the body — so a caller
  // can only create/overwrite their OWN guest record for their OWN branch,
  // closing the previous unauthenticated arbitrary-PII write.
  const guestId = req.user.guestId;
  const branchEmail = (req.user.email || "").toLowerCase();
  const { branchId, guestName, guestPhone, guestEmail } = req.body;

  if (!branchId || !branchEmail || !guestName || !guestEmail) {
    return res.status(400).json({
      error: "Required fields: branchId, guestName, guestEmail",
    });
  }

  try {
    const guestData = {
      branchId,
      branchEmail,
      guestId,
      guestName,
      guestPhone: guestPhone || null,
      guestEmail,
      createdAt: new Date().toISOString(),
    };
    await db.collection("guests").doc(guestId).set(guestData);
    return res
      .status(201)
      .json({ message: "Chat initialized successfully.", guest: guestData });
  } catch (err) {
    console.error("[MESSAGES:start] ❌", err);
    return res.status(500).json({ error: "Failed to initialize chat." });
  }
});

/**
 * POST /api/messages/send
 * Guest sends a message (idempotent via clientMessageId).
 */
router.post(
  "/send",
  authenticateGuest,     // verifies guestToken → req.user.{guestId,email}
  rateLimitByGuest,      // per-guest rate limiter
  optionalMediaUpload,   // only parses a file when one was actually sent
  ensureGuestOwns,       // enforces req.user.guestId === req.body.guestId
  async (req, res) => {
    try {
      // 1️⃣ Extract from JWT payload
      const guestId     = req.user.guestId;
      const branchEmail = (req.user.email || "").toLowerCase();

      // 2️⃣ Extract from body (multer also populates text fields for multipart)
      const {
        branchId,
        content = "",
        tempId,
        clientMessageId, // ← NEW, used for idempotency
        e2ee,            // ← E2EE flag (may be boolean or "true" from multipart)
        encryptionMeta,  // ← E2EE metadata (object or JSON string)
      } = req.body;

      // Normalize the E2EE flag (multipart form fields arrive as strings).
      const isE2EE = e2ee === true || e2ee === "true";
      let parsedEncryptionMeta = null;
      if (isE2EE && encryptionMeta) {
        try {
          parsedEncryptionMeta =
            typeof encryptionMeta === "string" ? JSON.parse(encryptionMeta) : encryptionMeta;
        } catch (_) {
          parsedEncryptionMeta = null;
        }
      }


      // ── Validation: require branchId; require content only if no file
      const hasFile = !!req.file;
      const textOk = typeof content === "string" && content.trim().length > 0;
      if (!branchId || (!hasFile && !textOk)) {
        return res
          .status(400)
          .json({ error: "branchId and non-empty content or a media file are required." });
      }

      // 3️⃣ Handle media upload (only if req.file exists)
      let media = null;
      if (hasFile) {
        if (req.file.mimetype.startsWith("image/")) {
          // image → stored privately; served via short-lived signed URL (P1-3)
          const fileName = `media/${guestId}/${uuidv4()}-${req.file.originalname}`;
          await uploadMediaToStorage(req.file.buffer, fileName, req.file.mimetype);
          media = { type: "image", path: fileName };
        } else {
          // non-image (PDF, etc) → stored privately; served via signed URL
          const fileName = `media/${guestId}/${uuidv4()}-${req.file.originalname}`;
          await uploadMediaToStorage(req.file.buffer, fileName, req.file.mimetype);
          media = { type: "file", path: fileName, name: req.file.originalname };
        }
      }

      // 4️⃣ Build message document (include clientMessageId if present)
      const rawContent = textOk ? content.trim() : null;
      const deterministicId   = clientMessageId || uuidv4();

      // Check for sensitive patterns and redact.
      // For E2EE messages the content is ciphertext the server cannot read —
      // never scan or redact it (that would corrupt the encrypted payload).
      const sensitivePatterns = (!isE2EE && rawContent) ? detectSensitivePatterns(rawContent) : [];
      const normalizedContent = (!isE2EE && rawContent) ? redactSensitiveData(rawContent) : rawContent;

      const messageData = {
        guestId,
        branchId,
        branchEmail,
        content: normalizedContent,
        sender:    "guest",
        status:    "sent",
        media,
        timestamp: new Date().toISOString(),
        tempId:    tempId || uuidv4(),
        clientMessageId: clientMessageId || deterministicId,
        // Metadata for sensitive data detection
        hasSensitiveData: sensitivePatterns.length > 0,
        sensitivePatterns: sensitivePatterns.length > 0 ? sensitivePatterns : null,
        // E2EE metadata so the recipient knows to decrypt the content.
        e2ee: isE2EE,
        encryptionMeta: parsedEncryptionMeta,
      };

      // 5️⃣ Idempotent persist:
      //  - if clientMessageId provided → use it as Firestore doc id
      //  - else create a new id and save as usual
      let saved;
      if (clientMessageId) {
        saved = await saveIdempotentMessage(clientMessageId, messageData);
      } else {
        // keep optimistic update compatibility first
        saved =
          (await tryUpdateOptimisticMessage(messageData.tempId, messageData)) || null;
        if (!saved) {
          const ref = await db.collection("messages").add(messageData);
          saved = { id: ref.id, ...messageData };
        }
      }

      // 6️⃣ Broadcast to all admins of that branch
      io.to(getRoomName("admin", branchEmail)).emit("receiveMessage", saved);

      // 7️⃣ Audit log if sensitive data was detected
      if (sensitivePatterns.length > 0) {
        await logSensitiveMessage(saved.id, rawContent, sensitivePatterns, guestId, branchEmail);
        console.log(`[AUDIT] Sensitive data detected in message ${saved.id}: ${sensitivePatterns.join(', ')}`);
      }

      // 8️⃣ Return saved message
      return res.status(201).json({ savedMessage: saved });
    } catch (err) {
      console.error("[MESSAGES:send] ❌", err);
      return res.status(500).json({ error: "Failed to send message." });
    }
  }
);


/**
 * POST /api/messages/reply
 * Branch admin replies to a guest. Also idempotent via clientMessageId.
 */
const adminReplySchema = z.object({
  guestId: z.string().min(1, "guestId is required."),
  content: z.string().min(1, "content is required.").optional(), // may be empty if file present
  tempId:  z.string().optional(),
  clientMessageId: z.string().optional(),
});

router.post(
  "/reply",
  authenticateBranchAdmin, // verifies branch admin token → req.branchEmail, req.branchId
  optionalMediaUpload,     // only parses a file when one was actually sent
  ensureBranchOwns,        // enforces req.branchEmail === payload.branchEmail
  async (req, res) => {
    try {
      // 1️⃣ Parse body (multer has already populated text fields)
      const parsed = adminReplySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors.map(e => e.message).join(", ") });
      }
      const { guestId, content, tempId, clientMessageId } = parsed.data;

      const branchEmail = req.branchEmail.toLowerCase();
      const branchId    = req.branchId;

      // Require either content or file
      const hasFile = !!req.file;
      const textOk  = typeof content === "string" && content.trim().length > 0;
      if (!hasFile && !textOk) {
        return res.status(400).json({ error: "content or a media file is required." });
      }

      // 2️⃣ Handle media upload (only if req.file exists)
      let media = null;
      if (hasFile) {
        if (req.file.mimetype.startsWith("image/")) {
          // Store the original image privately (no server-side resize: `sharp`
          // was removed for Node 24 compatibility — see P3-6). Served via a
          // short-lived signed URL (P1-3).
          const fileName = `media/${branchId}/${uuidv4()}-${req.file.originalname}`;
          await uploadMediaToStorage(req.file.buffer, fileName, req.file.mimetype);
          media = { type: "image", path: fileName };
        } else {
          const fileName = `media/${branchId}/${uuidv4()}-${req.file.originalname}`;
          await uploadMediaToStorage(req.file.buffer, fileName, req.file.mimetype);
          media = { type: "file", path: fileName, name: req.file.originalname };
        }
      }

      // 3️⃣ Build reply document
      const replyData = {
        guestId,
        branchId,
        branchEmail,
        content: textOk ? content.trim() : null,
        sender:    "branch",
        status:    "sent",
        media,
        timestamp: new Date().toISOString(),
        tempId:    tempId || uuidv4(),
        clientMessageId: clientMessageId || uuidv4(),
      };

      // 4️⃣ Idempotent persist for admin replies
      let saved;
      if (clientMessageId) {
        saved = await saveIdempotentMessage(clientMessageId, replyData);
      } else {
        // keep optimistic update compatibility
        saved =
          (await tryUpdateOptimisticMessage(replyData.tempId, replyData)) || null;
        if (!saved) {
          const ref = await db.collection("messages").add(replyData);
          saved = { id: ref.id, ...replyData };
        }
      }

      // 5️⃣ Broadcast to the specific guest room
      io.to(getRoomName("guest", guestId)).emit("receiveMessage", saved);

      // 6️⃣ Return saved reply
      return res
        .status(201)
        .json({ message: "Reply sent successfully.", savedReply: saved });
    } catch (err) {
      console.error("[MESSAGES:reply] ❌", err);
      return res.status(500).json({ error: "Failed to send reply." });
    }
  }
);


/**
 * GET /api/messages/history/:guestId
 * Retrieve chat history for a given guest under the authenticated branch.
 */
router.get(
  "/history/:guestId",
  authenticateBranchAdmin,
  requireMFA, // SPI gate: active MFA session required (P0-2)
  async (req, res) => {
    const { guestId } = req.params;
    if (!guestId) {
      return res.status(400).json({ error: "guestId is required." });
    }
    try {
      // PERF2-3: bound this previously-unlimited read. We fetch the most-recent
      // page DESC (so a huge conversation can't load entirely), then return it
      // ASC to preserve the existing `{ messages }` contract. `limit` caps page
      // size (default 200, hard max 500); `before` (ISO ts) is a cursor for
      // lazy-loading OLDER messages. Branch scoping is unchanged.
      const limitN = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      let q = db
        .collection("messages")
        .where("guestId", "==", guestId)
        .where("branchId", "==", req.branchId)
        .orderBy("timestamp", "desc");
      if (req.query.before) q = q.startAfter(String(req.query.before));
      const snap = await q.limit(limitN).get();

      const page = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const messages = page.reverse(); // back to ascending for the client
      const hasMore = snap.size === limitN;
      const nextBefore = hasMore && page.length ? page[0].timestamp : null;
      return res.status(200).json({ messages, hasMore, nextBefore });
    } catch (err) {
      console.error("[MESSAGES:history] ❌", err);
      return res.status(500).json({ error: "Failed to fetch history." });
    }
  }
);

/**
 * GET /api/messages/all
 * Super admin: retrieve all messages.
 */
router.get("/all", authenticateSuperAdmin, async (_req, res) => {
  try {
    const snap = await db
      .collection("messages")
      .orderBy("timestamp", "desc")
      .get();
    const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ messages });
  } catch (err) {
    console.error("[MESSAGES:all] ❌", err);
    return res.status(500).json({ error: "Failed to fetch all messages." });
  }
});

/**
 * PATCH /api/messages/mark-seen/:id
 * Mark a single message as seen (branch admin only, within own branch).
 */
router.patch(
  "/mark-seen/:id",
  authenticateBranchAdmin,
  async (req, res) => {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Message ID is required." });
    }
    try {
      const ref = db.collection("messages").doc(id);
      const docSnap = await ref.get();
      if (!docSnap.exists) {
        return res.status(404).json({ error: "Message not found." });
      }
      const data = docSnap.data();
      // Enforce ACL: branch may only update its own messages
      if (data.branchEmail !== req.branchEmail.toLowerCase()) {
        return res.status(403).json({ error: "Forbidden – wrong branch." });
      }
      await ref.update({ status: "seen", seenByAdmin: true });
      const updated = { id, ...data, status: "seen", seenByAdmin: true };
      io.to(getRoomName("guest", data.guestId)).emit("messageSeen", updated);
      return res
        .status(200)
        .json({ message: "Message marked as seen.", updatedMessage: updated });
    } catch (err) {
      console.error("[MESSAGES:mark-seen] ❌", err);
      return res.status(500).json({ error: "Failed to mark as seen." });
    }
  }
);

/**
 * POST /api/messages/conversation-key
 * Guest fetches (creating on first call) the AES-256 conversation key for its
 * own chat. The guest token carries guestId + the branch email (room mapping),
 * so we scope strictly to req.user — a guest can only ever obtain its own key.
 */
router.post("/conversation-key", authenticateGuest, async (req, res) => {
  try {
    const guestId = req.user.guestId;
    const branchEmail = (req.user.email || "").toLowerCase();
    if (!guestId || !branchEmail) {
      return res.status(400).json({ error: "guestId and branch are required." });
    }
    const key = await getOrCreateConversationKey(branchEmail, guestId);
    return res.status(200).json({ key });
  } catch (err) {
    console.error("[MESSAGES:conversation-key:guest] ❌", err);
    return res.status(500).json({ error: "Failed to fetch conversation key." });
  }
});

/**
 * GET /api/messages/conversation-key/:guestId
 * Branch admin fetches (creating on first call) the conversation key for a guest
 * in its own branch. Scoped to req.branchEmail so an admin can only read keys
 * for conversations belonging to their branch. Works even when the guest is
 * offline, enabling history decryption.
 */
router.get(
  "/conversation-key/:guestId",
  authenticateBranchAdmin,
  requireMFA, // SPI gate: active MFA session required to obtain decryption key (P0-2)
  async (req, res) => {
    try {
      const { guestId } = req.params;
      const branchEmail = (req.branchEmail || "").toLowerCase();
      if (!guestId || !branchEmail) {
        return res.status(400).json({ error: "guestId and branch are required." });
      }
      const key = await getOrCreateConversationKey(branchEmail, guestId);
      return res.status(200).json({ key });
    } catch (err) {
      console.error("[MESSAGES:conversation-key:admin] ❌", err);
      return res.status(500).json({ error: "Failed to fetch conversation key." });
    }
  }
);

/**
 * GET /api/messages/media/:id        (guest)
 * GET /api/messages/admin-media/:id   (branch admin + active MFA session)
 * Return short-lived signed URL(s) for a message's media, scoped strictly to
 * the authenticated participant. Chat objects are stored PRIVATE (P1-3), so a
 * fresh signed URL is minted per request and expires in ~15 min.
 */
router.get("/media/:id", authenticateGuest, async (req, res) => {
  try {
    const snap = await db.collection("messages").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "Message not found." });
    const m = snap.data();
    if (normGuestKeyId(m.guestId) !== normGuestKeyId(req.user.guestId)) {
      return res.status(403).json({ error: "Forbidden." });
    }
    const signed = await signMessageMedia(m.media);
    if (!signed) return res.status(404).json({ error: "No media on this message." });
    return res.status(200).json(signed);
  } catch (err) {
    console.error("[MESSAGES:media:guest] ❌", err);
    return res.status(500).json({ error: "Failed to resolve media." });
  }
});

router.get(
  "/admin-media/:id",
  authenticateBranchAdmin,
  requireMFA, // SPI gate: active MFA session required to view chat media (P0-2/P1-3)
  async (req, res) => {
    try {
      const branchEmail = (req.branchEmail || "").toLowerCase();
      const snap = await db.collection("messages").doc(req.params.id).get();
      if (!snap.exists) return res.status(404).json({ error: "Message not found." });
      const m = snap.data();
      if ((m.branchEmail || "").toLowerCase() !== branchEmail) {
        return res.status(403).json({ error: "Forbidden." });
      }
      const signed = await signMessageMedia(m.media);
      if (!signed) return res.status(404).json({ error: "No media on this message." });
      return res.status(200).json(signed);
    } catch (err) {
      console.error("[MESSAGES:media:admin] ❌", err);
      return res.status(500).json({ error: "Failed to resolve media." });
    }
  }
);

/**
 * PATCH /api/messages/mark-seen-by-guest/:id
 * Mark a message as seen by guest (guest only, for their own messages).
 */
router.patch(
  "/mark-seen-by-guest/:id",
  authenticateGuest,
  async (req, res) => {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Message ID is required." });
    }
    try {
      const guestId = req.user.guestId;
      const ref = db.collection("messages").doc(id);
      const docSnap = await ref.get();
      if (!docSnap.exists) {
        return res.status(404).json({ error: "Message not found." });
      }
      const data = docSnap.data();
      // Enforce ACL: guest may only update their own messages. Compare on the
      // normalized id (lowercase + strip "guest-" prefix) so a harmless format
      // difference between the token's guestId and the stored guestId — e.g.
      // "guest-123" vs "123" across the init/refresh/fallback token paths —
      // does not produce a false 403 for the guest's own conversation.
      const normGuestId = (s = "") =>
        String(s).toLowerCase().replace(/^guest-/, "").trim();
      if (normGuestId(data.guestId) !== normGuestId(guestId)) {
        return res.status(403).json({ error: "Forbidden – wrong guest." });
      }
      await ref.update({ seenByGuest: true });
      const updated = { id, ...data, seenByGuest: true };
      io.to(getRoomName("admin", data.branchEmail)).emit("messageSeenByGuest", updated);
      return res
        .status(200)
        .json({ message: "Message marked as seen by guest.", updatedMessage: updated });
    } catch (err) {
      console.error("[MESSAGES:mark-seen-by-guest] ❌", err);
      return res.status(500).json({ error: "Failed to mark as seen by guest." });
    }
  }
);

module.exports = router;
