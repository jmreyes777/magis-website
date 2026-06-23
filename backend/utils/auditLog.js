// backend/utils/auditLog.js
//
// Centralized, append-only audit trail for long-term monitoring and
// RA 10173 (Philippine Data Privacy Act) compliance — focused on the chat
// function but usable for auth, data-access, admin-governance and security
// events too.
//
// Design contract:
//   - WRITES ARE BEST-EFFORT AND NEVER THROW. Instrumentation calls must never
//     break the primary flow (a failed audit write only emits a console warning).
//   - PII-MINIMIZED. Raw message content, passwords, tokens, OTPs and media are
//     never persisted; sensitive keys are stripped and guest emails are masked.
//   - APPEND-ONLY. Documents are written via the Admin SDK (bypassing client
//     Firestore rules, which deny all client access to this collection).
//
// Each event document shape:
//   {
//     ts: ISO-8601 string (sorts chronologically),
//     tsMs: number (epoch ms),
//     category: 'chat'|'access'|'auth'|'admin'|'security',
//     action:  e.g. 'chat.closed' (see ACTIONS),
//     severity:'info'|'notice'|'warning'|'critical',
//     outcome: 'success'|'failure'|'blocked',
//     actor:   { type, id, email, branchEmail, role },
//     target:  { type, id, guestId },
//     branchEmail: string|null,   // denormalized for indexed branch-scoped reads
//     context: { ip, userAgent, sessionId, country },
//     meta:    { ... },           // action-specific, sanitized
//     expireAt: Date              // for an optional Firestore TTL policy
//   }

const { db } = require("./firebase");

const COLLECTION = process.env.AUDIT_COLLECTION || "auditLogs";
const RETENTION_DAYS = Math.max(parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 365, 1);
const IS_DEV = process.env.NODE_ENV === "development";

const CATEGORIES = ["chat", "access", "auth", "admin", "security"];
const SEVERITIES = ["info", "notice", "warning", "critical"];
const OUTCOMES = ["success", "failure", "blocked"];
const ACTOR_TYPES = ["guest", "branchadmin", "superadmin", "staff", "system"];

// Categories a branch admin is allowed to see for their OWN branch (chat
// self-view). Security/auth/admin-governance remain super-admin only. The read
// API enforces this; it is exported so the route and tests share one source.
const BRANCH_VISIBLE_CATEGORIES = ["chat", "access"];

// Canonical action catalog (keeps action strings consistent across the codebase
// and feeds the dashboard filter dropdowns via GET /api/audit/meta).
const ACTIONS = {
  // ── chat lifecycle ──────────────────────────────────────────────
  CHAT_SESSION_START: "chat.session.start",
  CHAT_GUEST_JOIN: "chat.guest.join",
  CHAT_ADMIN_JOIN: "chat.admin.join",
  CHAT_CLOSED: "chat.closed",
  CHAT_ARCHIVED: "chat.archived",
  CHAT_TRANSCRIPT_REQUESTED: "chat.transcript.requested",
  CHAT_TRANSCRIPT_EMAILED: "chat.transcript.emailed",
  CHAT_RATE_LIMITED: "chat.rate_limited",
  CHAT_SENSITIVE_DETECTED: "chat.sensitive_detected",
  CHAT_BRANCH_ONLINE: "chat.branch.online",
  CHAT_BRANCH_OFFLINE: "chat.branch.offline",
  // ── data access (DPA access logging) ────────────────────────────
  ACCESS_CONVERSATION_VIEWED: "access.conversation.viewed",
  ACCESS_TRANSCRIPT_EXPORTED: "access.transcript.exported",
  ACCESS_ANALYTICS_VIEWED: "access.analytics.viewed",
  ACCESS_AUDIT_VIEWED: "access.audit.viewed",
  ACCESS_AUDIT_EXPORTED: "access.audit.exported",
  // ── authentication ──────────────────────────────────────────────
  AUTH_LOGIN_SUCCESS: "auth.login.success",
  AUTH_LOGIN_FAILURE: "auth.login.failure",
  AUTH_OTP_ISSUED: "auth.otp.issued",
  AUTH_OTP_VERIFIED: "auth.otp.verified",
  AUTH_OTP_FAILED: "auth.otp.failed",
  AUTH_PASSWORD_CHANGED: "auth.password.changed",
  AUTH_PASSWORD_RESET_REQUESTED: "auth.password.reset_requested",
  AUTH_PASSWORD_RESET: "auth.password.reset",
  AUTH_ACCOUNT_LOCKED: "auth.account.locked",
  AUTH_TRUSTED_DEVICE_ADDED: "auth.trusted_device.added",
  AUTH_TRUSTED_DEVICE_REVOKED: "auth.trusted_device.revoked",
  AUTH_MFA_ENABLED: "auth.mfa.enabled",
  AUTH_MFA_DISABLED: "auth.mfa.disabled",
  AUTH_LOGOUT: "auth.logout",
  // ── admin governance ────────────────────────────────────────────
  ADMIN_BRANCH_CREATED: "admin.branch.created",
  ADMIN_BRANCH_UPDATED: "admin.branch.updated",
  ADMIN_BRANCH_DELETED: "admin.branch.deleted",
  ADMIN_STAFF_CREATED: "admin.staff.created",
  ADMIN_STAFF_UPDATED: "admin.staff.updated",
  ADMIN_STAFF_DELETED: "admin.staff.deleted",
  ADMIN_BRANCH_PASSWORD_SET: "admin.branch_password.set",
  ADMIN_BRANCH_PASSWORD_RESET: "admin.branch_password.reset",
  ADMIN_CLAIMS_ASSIGNED: "admin.claims.assigned",
  // ── security ────────────────────────────────────────────────────
  SECURITY_GEO_ANOMALY: "security.geo_anomaly",
  SECURITY_EDGE_AUTH_BLOCKED: "security.edge_auth.blocked",
  SECURITY_CONV_KEY_REGENERATED: "security.conv_key.regenerated",
};

// Keys that must never be persisted (case-insensitive). Defense-in-depth: even
// if a caller accidentally passes these in meta, they are dropped.
const SENSITIVE_KEYS = new Set(
  [
    "content", "message", "messages", "body", "text", "transcript",
    "password", "newpassword", "currentpassword", "oldpassword",
    "token", "accesstoken", "refreshtoken", "idtoken", "loginticket",
    "otp", "code", "secret", "privatekey", "apikey",
    "authorization", "cookie", "media", "attachment", "file", "buffer",
  ].map((k) => k.toLowerCase())
);

const MAX_STR = 1024;
const MAX_UA = 256;
const MAX_META_KEYS = 40;
const MAX_ARRAY_ITEMS = 50;

function clampStr(value, max = MAX_STR) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** Mask a guest/user email for compliance logging: jo***@example.com */
function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.toLowerCase().split("@");
  const head = local.slice(0, 2);
  return `${head}${local.length > 2 ? "***" : "*"}@${domain}`;
}

/** Shallow, defensive sanitizer for the free-form meta object. */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  const out = {};
  let count = 0;
  for (const [key, val] of Object.entries(meta)) {
    if (count >= MAX_META_KEYS) break;
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) continue;
    if (val == null) {
      out[key] = null;
    } else if (typeof val === "string") {
      out[key] = clampStr(val);
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = val;
    } else if (Array.isArray(val)) {
      out[key] = val.slice(0, MAX_ARRAY_ITEMS).map((v) =>
        typeof v === "object" ? clampStr(JSON.stringify(v)) : (typeof v === "string" ? clampStr(v) : v)
      );
    } else if (typeof val === "object") {
      out[key] = clampStr(JSON.stringify(val));
    }
    count++;
  }
  return out;
}

function normalizeActor(a = {}) {
  const type = ACTOR_TYPES.includes(a.type) ? a.type : "system";
  return {
    type,
    id: a.id != null ? clampStr(a.id, 128) : null,
    email: a.email ? String(a.email).toLowerCase() : null,
    branchEmail: a.branchEmail ? String(a.branchEmail).toLowerCase() : null,
    role: a.role || null,
  };
}

/**
 * Build the audit `context` block from an Express request. Reuses the same
 * forwarded-header conventions as geoSecurity (edge worker sets X-Forwarded-For
 * and X-Geo-Country). Never throws.
 */
function auditContextFromReq(req) {
  try {
    if (!req) return {};
    const xff = req.headers?.["x-forwarded-for"];
    const ip = (typeof xff === "string" && xff.split(",")[0].trim())
      || req.ip
      || req.socket?.remoteAddress
      || null;
    return {
      ip: ip ? clampStr(ip, 64) : null,
      userAgent: clampStr(req.headers?.["user-agent"], MAX_UA),
      sessionId: clampStr(req.headers?.["x-session-id"], 128) || null,
      country: clampStr(req.headers?.["x-geo-country"], 8) || null,
    };
  } catch {
    return {};
  }
}

/**
 * Record one audit event. Best-effort: resolves true on success, false on any
 * failure, and NEVER rejects — safe to call without awaiting in hot paths.
 *
 * @param {object} evt
 * @param {string} evt.category   one of CATEGORIES (defaults to 'chat')
 * @param {string} evt.action     canonical action string (see ACTIONS)
 * @param {string} [evt.severity] one of SEVERITIES (defaults to 'info')
 * @param {string} [evt.outcome]  one of OUTCOMES (defaults to 'success')
 * @param {object} [evt.actor]    { type, id, email, branchEmail, role }
 * @param {object} [evt.target]   { type, id, guestId }
 * @param {string} [evt.branchEmail]
 * @param {object} [evt.context]  { ip, userAgent, sessionId, country }
 * @param {object} [evt.meta]     action-specific, sanitized before write
 */
async function recordAuditEvent(evt = {}) {
  try {
    const nowMs = Date.now();
    const actor = normalizeActor(evt.actor);
    const target = {
      type: evt.target?.type ? clampStr(evt.target.type, 32) : null,
      id: evt.target?.id != null ? clampStr(evt.target.id, 128) : null,
      guestId: evt.target?.guestId != null ? clampStr(evt.target.guestId, 128) : null,
    };
    const branchEmailRaw =
      evt.branchEmail || actor.branchEmail || evt.target?.branchEmail || null;

    const doc = {
      ts: new Date(nowMs).toISOString(),
      tsMs: nowMs,
      category: CATEGORIES.includes(evt.category) ? evt.category : "chat",
      action: clampStr(evt.action || "unknown", 64),
      severity: SEVERITIES.includes(evt.severity) ? evt.severity : "info",
      outcome: OUTCOMES.includes(evt.outcome) ? evt.outcome : "success",
      actor,
      target,
      branchEmail: branchEmailRaw ? String(branchEmailRaw).toLowerCase() : null,
      context: {
        ip: evt.context?.ip ? clampStr(evt.context.ip, 64) : null,
        userAgent: clampStr(evt.context?.userAgent, MAX_UA),
        sessionId: evt.context?.sessionId ? clampStr(evt.context.sessionId, 128) : null,
        country: evt.context?.country ? clampStr(evt.context.country, 8) : null,
      },
      meta: sanitizeMeta(evt.meta),
      expireAt: new Date(nowMs + RETENTION_DAYS * 86400000),
    };

    await db.collection(COLLECTION).add(doc);

    if (IS_DEV) {
      console.log(
        `[AUDIT] ${doc.category}/${doc.action} (${doc.severity}/${doc.outcome}) ` +
          `actor=${doc.actor.email || doc.actor.type} branch=${doc.branchEmail || "-"}`
      );
    }
    return true;
  } catch (e) {
    console.warn("[AUDIT] Failed to record event:", e?.message || e);
    return false;
  }
}

module.exports = {
  recordAuditEvent,
  auditContextFromReq,
  maskEmail,
  COLLECTION,
  CATEGORIES,
  SEVERITIES,
  OUTCOMES,
  ACTOR_TYPES,
  ACTIONS,
  BRANCH_VISIBLE_CATEGORIES,
  RETENTION_DAYS,
};
