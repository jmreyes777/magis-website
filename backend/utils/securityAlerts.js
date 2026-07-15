// backend/utils/securityAlerts.js
//
// Real-time security alerting (megaplan Phase 4).
//
// Design contract (mirrors auditLog.js):
//   - FIRE-AND-FORGET, NEVER THROWS. An alerting failure must never affect the
//     request path that triggered it.
//   - THROTTLED per rule key so an attack can't turn the alert channel into a
//     mailbox flood (default 4 alerts / rule / hour; Redis-backed so the cap
//     holds across instances, with an in-memory fallback).
//   - TRANSPORTS (all optional, all free): email via utils/email.js to
//     SECURITY_ALERT_EMAIL (falls back to the first SUPERADMIN_EMAILS entry),
//     and Telegram via ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID.
//   - Fully dormant when no transport is configured (or when
//     SECURITY_ALERTS_ENABLED=false), so this ships with zero behavior change
//     until the operator opts in.
//
// Initial rules wired (see call sites):
//   R1 login-failures     ≥ N failed admin logins / 15 min per IP or account
//                         (central hook in auditLog.recordAuditEvent)
//   R2 edge-auth          non-edge /api requests (geoSecurity.requireEdgeAuth)
//   R3 geo-anomaly        international session change (geoSecurity.logGeoAnomaly)
//   R4 redis-degraded     Redis errors while limits/revocation depend on it (server.js)
//   R5 login-429          login rate-limiter tripping (server.js loginLimiter)

const { isEmailConfigured, sendMail } = require("./email");

const ENABLED = String(process.env.SECURITY_ALERTS_ENABLED || "true") !== "false";
const MAX_PER_HOUR = Math.max(parseInt(process.env.SECURITY_ALERTS_MAX_PER_HOUR, 10) || 4, 1);
const LOGIN_FAIL_THRESHOLD = Math.max(parseInt(process.env.LOGIN_FAIL_ALERT_THRESHOLD, 10) || 3, 2);
const LOGIN_FAIL_WINDOW_SEC = 15 * 60;

const TG_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.ALERT_TELEGRAM_CHAT_ID || "";

function alertEmailTo() {
  if (process.env.SECURITY_ALERT_EMAIL) return process.env.SECURITY_ALERT_EMAIL;
  const first = (process.env.SUPERADMIN_EMAILS || "").split(",")[0].trim();
  return first || "";
}

function hasAnyTransport() {
  return Boolean((isEmailConfigured() && alertEmailTo()) || (TG_TOKEN && TG_CHAT));
}

// ── Throttle (Redis INCR/EXPIRE with in-memory fallback) ────────────────────
const memThrottle = new Map(); // key -> { count, resetAt }

async function underThrottle(ruleKey) {
  const key = `sec:alert:${ruleKey}`;
  try {
    const { getRedis, isRedisConfigured } = require("./redis");
    if (isRedisConfigured()) {
      const r = getRedis();
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, 3600);
      return n <= MAX_PER_HOUR;
    }
  } catch {
    /* fall through to memory */
  }
  const now = Date.now();
  const slot = memThrottle.get(key);
  if (!slot || now >= slot.resetAt) {
    memThrottle.set(key, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  slot.count += 1;
  return slot.count <= MAX_PER_HOUR;
}

// ── Transports ───────────────────────────────────────────────────────────────
async function deliver(title, lines) {
  const text = lines.filter(Boolean).join("\n");
  const jobs = [];

  if (isEmailConfigured() && alertEmailTo()) {
    jobs.push(
      sendMail({
        to: alertEmailTo(),
        subject: `[MAGIS SECURITY] ${title}`,
        text: `${title}\n\n${text}\n\nSent by the Magis backend security alerting (Phase 4).`,
      }).catch((e) => console.warn("[ALERT] email transport failed:", e?.message))
    );
  }

  if (TG_TOKEN && TG_CHAT) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          // BDR2: success heartbeats (e.g. "✅ Backup ok") bring their own
          // leading emoji — only prepend the siren when the title has none.
          text: `${/^[✅🟢ℹ]/u.test(title) ? "" : "🚨 "}${title}\n${text}`,
          disable_web_page_preview: true,
        }),
      })
        .then((r) => {
          if (!r.ok) console.warn("[ALERT] telegram transport HTTP", r.status);
        })
        .catch((e) => console.warn("[ALERT] telegram transport failed:", e?.message))
    );
  }

  await Promise.allSettled(jobs);
}

/**
 * Send a throttled security alert. Fire-and-forget: call WITHOUT await from
 * request paths. Resolves true when a delivery was attempted.
 *
 * @param {string} ruleKey  stable id for throttling, e.g. "login-failures:1.2.3.4"
 * @param {string} title    short human title
 * @param {string[]} lines  detail lines (avoid secrets/PII — recipients are ops)
 */
async function sendSecurityAlert(ruleKey, title, lines = []) {
  try {
    if (!ENABLED || !hasAnyTransport()) return false;
    if (!(await underThrottle(ruleKey))) return false;
    console.warn(`[ALERT] 🚨 ${title} (rule=${ruleKey})`);
    await deliver(title, [...lines, `time: ${new Date().toISOString()}`]);
    return true;
  } catch (e) {
    console.warn("[ALERT] sendSecurityAlert failed:", e?.message || e);
    return false;
  }
}

// ── R1: failed-login spike detection ────────────────────────────────────────
const memFail = new Map(); // key -> { count, resetAt }

async function bumpFailCounter(kind, id) {
  const key = `sec:lf:${kind}:${id}`;
  try {
    const { getRedis, isRedisConfigured } = require("./redis");
    if (isRedisConfigured()) {
      const r = getRedis();
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, LOGIN_FAIL_WINDOW_SEC);
      return n;
    }
  } catch {
    /* fall through */
  }
  const now = Date.now();
  const slot = memFail.get(key);
  if (!slot || now >= slot.resetAt) {
    memFail.set(key, { count: 1, resetAt: now + LOGIN_FAIL_WINDOW_SEC * 1000 });
    return 1;
  }
  slot.count += 1;
  return slot.count;
}

/**
 * Count a failed admin login and alert when the 15-minute threshold is crossed
 * for the source IP or the target account. Fire-and-forget.
 */
async function noteLoginFailure({ ip, email, route } = {}) {
  try {
    if (!ENABLED || !hasAnyTransport()) return;
    const checks = [];
    if (ip) checks.push(["ip", String(ip)]);
    if (email) checks.push(["em", String(email).toLowerCase()]);
    for (const [kind, id] of checks) {
      const n = await bumpFailCounter(kind, id);
      if (n === LOGIN_FAIL_THRESHOLD) {
        // Alert exactly once per window per key (further failures ride the throttle).
        sendSecurityAlert(
          `login-failures:${kind}:${id}`,
          `Failed-login spike (${n} in 15 min)`,
          [
            `${kind === "ip" ? "source IP" : "account"}: ${id}`,
            route ? `route: ${route}` : "",
            "action: investigate; consider blocking the IP at the edge if it continues",
          ]
        );
      }
    }
  } catch (e) {
    console.warn("[ALERT] noteLoginFailure failed:", e?.message || e);
  }
}

module.exports = { sendSecurityAlert, noteLoginFailure };
