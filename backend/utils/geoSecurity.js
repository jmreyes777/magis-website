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
  SECURITY_ANOMALY_COLLECTION,
  normalizeCountry,
  isEdgeTrusted,
  getClientGeo,
  logGeoAnomaly,
  isInternationalChange,
};
