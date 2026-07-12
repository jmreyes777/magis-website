// backend/utils/geoSecurity.js
//
// Geolocation anomaly detection helpers.
//
// Source of truth for the client country is the `X-Geo-Country` header set by
// the Cloudflare edge worker (from request.cf.country / CF-IPCountry). The real
// client IP arrives via `X-Forwarded-For` (also set by the worker).
//
// In non-production environments there is no real Cloudflare geo data, so a
// debug override is supported for local testing:
//   - request header `X-Debug-Country` (e.g. "US"), or
//   - env var `DEV_GEO_COUNTRY`.

const crypto = require("crypto");
const { db } = require("./firebase");
const { recordAuditEvent, ACTIONS } = require("./auditLog");
const { sendSecurityAlert } = require("./securityAlerts");

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const GEO_ANOMALY_ENABLED = String(process.env.GEO_ANOMALY_ENABLED || "true") === "true";
// Rollout mode: "monitor" logs anomalies without locking the session;
// "enforce" (default) forces MFA re-verification on an international change.
const GEO_ANOMALY_MODE =
  String(process.env.GEO_ANOMALY_MODE || "enforce").toLowerCase() === "monitor"
    ? "monitor"
    : "enforce";
// Shared secret injected by the Cloudflare edge worker (header X-Edge-Auth).
// When set, the backend only trusts forwarded geo headers from the edge.
const EDGE_SHARED_SECRET = process.env.EDGE_SHARED_SECRET || "";
const SECURITY_ANOMALY_COLLECTION = "securityAnomalies";

// P2-2: origin lock-down rollout mode. "monitor" (default) logs non-edge /api
// requests WITHOUT blocking — use it first to confirm that all legitimate
// traffic carries the edge secret. "enforce" 403s any /api request that did not
// come through the Cloudflare worker. We default to monitor on purpose: a
// premature "enforce" (e.g. the worker isn't injecting the header yet) would
// 403 ALL API traffic, so enabling blocking must be an explicit, deliberate act.
const EDGE_AUTH_MODE =
  String(process.env.EDGE_AUTH_MODE || "monitor").toLowerCase() === "enforce"
    ? "enforce"
    : "monitor";

/**
 * Constant-time string comparison (avoids timing leaks on the secret).
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Whether this request can be trusted to carry edge-provided geo headers.
 * - Non-production: always trusted (so local dev / dev override works).
 * - Production with EDGE_SHARED_SECRET set: only requests carrying the matching
 *   X-Edge-Auth header (i.e. proxied by our Cloudflare worker) are trusted.
 * - Production without a configured secret: trusted (backward compatible), but
 *   relies on origin lockdown — configuring the secret is strongly recommended.
 */
function isEdgeTrusted(req) {
  if (!IS_PRODUCTION) return true;
  if (!EDGE_SHARED_SECRET) return true;
  return safeEqual(req.headers["x-edge-auth"] || "", EDGE_SHARED_SECRET);
}

let __lastEdgeAuthLogAt = 0;

/**
 * Express middleware that locks the origin to the Cloudflare edge (P2-2).
 *
 * The edge worker injects `X-Edge-Auth: <EDGE_SHARED_SECRET>` on every /api
 * request it proxies (see withForwardedGeo in magis-edge-worker/index.js).
 * Direct-to-origin requests that bypass the edge — and therefore its JWT, rate
 * limiting and geo controls — will not carry a valid value.
 *
 * Rollout-safe by design:
 *   - Non-production            → always allowed (no edge in front of dev).
 *   - EDGE_SHARED_SECRET unset  → always allowed (fail-open, backward compat).
 *   - OPTIONS preflight         → always allowed (CORS carries no secret).
 *   - Valid X-Edge-Auth         → allowed.
 *   - Otherwise: "monitor" logs (throttled) + allows; "enforce" returns 403.
 *
 * Mount on the sensitive surface only — app.use("/api", requireEdgeAuth) — so
 * health probes (/health) and the realtime transport (/socket.io) are never
 * affected.
 */
function requireEdgeAuth(req, res, next) {
  if (!IS_PRODUCTION) return next();
  if (!EDGE_SHARED_SECRET) return next();
  if (req.method === "OPTIONS") return next();

  const provided = req.headers["x-edge-auth"] || "";
  if (provided && safeEqual(provided, EDGE_SHARED_SECRET)) return next();

  const now = Date.now();
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
  if (now - __lastEdgeAuthLogAt > 30_000) {
    __lastEdgeAuthLogAt = now;
    console.warn(
      `[SECURITY] 🚧 Non-edge origin request (${EDGE_AUTH_MODE}) ${req.method} ${req.originalUrl} from ${ip || "?"}` +
        (EDGE_AUTH_MODE === "enforce" ? " — BLOCKED (403)" : " — allowed (monitor)")
    );
    // R2 (Phase 4): chained audit event + throttled alert. Inside the 30s log
    // throttle so a direct-to-origin scan can't flood Firestore or the inbox
    // (sendSecurityAlert additionally applies its own per-hour cap).
    recordAuditEvent({
      category: "security",
      action: ACTIONS.SECURITY_EDGE_AUTH_BLOCKED,
      severity: EDGE_AUTH_MODE === "enforce" ? "critical" : "warning",
      outcome: EDGE_AUTH_MODE === "enforce" ? "blocked" : "success",
      actor: { type: "system" },
      context: { ip: ip || null, userAgent: req.headers["user-agent"] || null },
      meta: { mode: EDGE_AUTH_MODE, method: req.method, path: req.originalUrl },
    });
    sendSecurityAlert(
      "edge-auth-violation",
      `Non-edge /api request ${EDGE_AUTH_MODE === "enforce" ? "BLOCKED" : "observed (monitor)"}`,
      [
        `source IP: ${ip || "?"}`,
        `request: ${req.method} ${req.originalUrl}`,
        `mode: ${EDGE_AUTH_MODE}`,
        "meaning: something is hitting the Render origin directly, bypassing the Cloudflare edge",
      ]
    );
  }

  if (EDGE_AUTH_MODE === "enforce") {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

// Startup visibility (P2-2): make the origin-lock posture obvious in prod logs
// so it can never be silently inert (mirrors the P2-1 observability fix).
if (IS_PRODUCTION) {
  if (EDGE_SHARED_SECRET) {
    console.log(
      `[SECURITY] 🔒 Origin edge-lock: secret SET, mode=${EDGE_AUTH_MODE}` +
        (EDGE_AUTH_MODE === "monitor"
          ? " (logging only — set EDGE_AUTH_MODE=enforce to block non-edge /api)"
          : " (blocking non-edge /api)")
    );
  } else {
    console.warn(
      "[SECURITY] ⚠️ Origin edge-lock DISABLED: EDGE_SHARED_SECRET not set — direct-to-origin /api bypasses edge JWT/rate/geo controls (P2-2)."
    );
  }
}

/**
 * Normalize a country code to an uppercase ISO-3166 alpha-2 string, or "".
 */
function normalizeCountry(value) {
  if (!value || typeof value !== "string") return "";
  const c = value.trim().toUpperCase();
  // Cloudflare uses "XX"/"T1" for unknown / Tor; treat as unknown.
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return "";
  return c;
}

/**
 * Extract the trusted client IP + country from a request.
 * Returns { ip, country } where either may be "" when unavailable.
 */
function getClientGeo(req) {
  const trusted = isEdgeTrusted(req);

  // Country: only honor edge-provided geo headers when the request is trusted
  // (i.e. came through our Cloudflare worker). Untrusted requests yield an
  // unknown country, which fails open (no false anomaly) rather than allowing
  // a spoofed country to influence detection.
  let country = trusted ? normalizeCountry(req.headers["x-geo-country"]) : "";
  if (!country && !IS_PRODUCTION) {
    country =
      normalizeCountry(req.headers["x-debug-country"]) ||
      normalizeCountry(process.env.DEV_GEO_COUNTRY);
  }

  // IP: first hop of X-Forwarded-For, then Express req.ip (trust proxy on).
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xff || req.ip || req.connection?.remoteAddress || "";

  return { ip, country, edgeTrusted: trusted };
}

/**
 * Rate-limit key = the most trustworthy client IP we can derive (P3-2).
 *
 * Edge-routed traffic: the Cloudflare worker STRIPS any client-supplied
 * X-Forwarded-For and sets a single authoritative entry (the real client IP),
 * authenticated via X-Edge-Auth. We key off that, so an attacker can NOT mint
 * unlimited rate-limit buckets by rotating spoofed X-Forwarded-For values.
 *
 * Untrusted / direct-to-origin traffic (no valid edge secret) falls back to
 * Express `req.ip` — now derived from a PINNED `trust proxy` hop count (see
 * server.js) rather than the entire client-controlled chain — and finally the
 * raw socket peer. In every branch the key is not attacker-controlled.
 *
 * Returns a stable string suitable for an express-rate-limit `keyGenerator`.
 */
function rateLimitKey(req) {
  const { ip, edgeTrusted } = getClientGeo(req);
  if (edgeTrusted && ip) return ip;
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Record a geolocation anomaly to Firestore for the audit trail.
 * Best-effort: never throws.
 */
async function logGeoAnomaly({ email, sessionId, fromCountry, toCountry, ip, userAgent }) {
  try {
    await db.collection(SECURITY_ANOMALY_COLLECTION).add({
      type: "geo_international_change",
      mode: GEO_ANOMALY_MODE,
      enforced: GEO_ANOMALY_MODE === "enforce",
      email: email || null,
      sessionId: sessionId || null,
      fromCountry: fromCountry || null,
      toCountry: toCountry || null,
      ip: ip || null,
      userAgent: userAgent || null,
      detectedAt: new Date().toISOString(),
    });
    console.warn(
      `[SECURITY] 🌍 Geo anomaly (${GEO_ANOMALY_MODE}) for ${email} (session ${sessionId}): ${fromCountry} → ${toCountry}`
    );
  } catch (e) {
    console.warn("[SECURITY] Failed to log geo anomaly:", e.message);
  }

  // R3 (Phase 4): real-time notification on top of the audit record.
  sendSecurityAlert(`geo-anomaly:${email || ip || "unknown"}`, "Admin session country change", [
    `account: ${email || "?"}`,
    `change: ${fromCountry || "?"} → ${toCountry || "?"}`,
    `source IP: ${ip || "?"}`,
    `mode: ${GEO_ANOMALY_MODE}${GEO_ANOMALY_MODE === "enforce" ? " (MFA re-verification forced)" : ""}`,
  ]);

  // Mirror into the unified audit trail so geo anomalies surface in the
  // compliance dashboard alongside chat/auth events (best-effort).
  recordAuditEvent({
    category: "security",
    action: ACTIONS.SECURITY_GEO_ANOMALY,
    severity: GEO_ANOMALY_MODE === "enforce" ? "critical" : "warning",
    outcome: GEO_ANOMALY_MODE === "enforce" ? "blocked" : "success",
    actor: { type: "system", email: email || null },
    context: {
      ip: ip || null,
      userAgent: userAgent || null,
      sessionId: sessionId || null,
      country: toCountry || null,
    },
    meta: {
      fromCountry: fromCountry || null,
      toCountry: toCountry || null,
      mode: GEO_ANOMALY_MODE,
    },
  });
}

/**
 * Pure detection: is this an international (country-level) change?
 * Fails open: if either country is unknown, it is NOT considered an anomaly.
 */
function isInternationalChange(baselineCountry, currentCountry) {
  if (!GEO_ANOMALY_ENABLED) return false;
  const a = normalizeCountry(baselineCountry);
  const b = normalizeCountry(currentCountry);
  if (!a || !b) return false;
  return a !== b;
}

module.exports = {
  GEO_ANOMALY_ENABLED,
  GEO_ANOMALY_MODE,
  EDGE_AUTH_MODE,
  SECURITY_ANOMALY_COLLECTION,
  normalizeCountry,
  isEdgeTrusted,
  requireEdgeAuth,
  getClientGeo,
  rateLimitKey,
  logGeoAnomaly,
  isInternationalChange,
};
