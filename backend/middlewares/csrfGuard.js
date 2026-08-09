// backend/middlewares/csrfGuard.js
//
// SEC26 Wave 0 (CSRF-1 closure): the double-submit token issued by
// GET /api/csrf-token was never validated server-side. This guard performs
// that validation — but ONLY where CSRF is actually a threat: mutating
// requests whose credential arrived via a browser-managed COOKIE. Bearer
// headers and body-carried tokens (sendBeacon paths) are attacker-unreachable
// cross-site, so those flows are deliberately exempt — enforcing there would
// break API clients for zero security gain.
//
// Staged rollout (mirrors the P2-2 edge-lock pattern):
//   CSRF_ENFORCE unset/false → monitor: log-only warning, request proceeds.
//   CSRF_ENFORCE=true        → enforce: 403 before any business logic.
//
// Contract: auth middlewares call this AFTER resolving the token source.
// Returns true when the request was rejected (caller must `return`), null
// when the request may proceed.

const crypto = require("crypto");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isEnforced = () =>
  String(process.env.CSRF_ENFORCE || "").toLowerCase() === "true";

// Constant-time comparison; length mismatch handled without early-exit timing
// signal on the token bytes themselves.
function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {true|null} true = rejected (response already sent), null = pass
 */
function csrfGuard(req, res) {
  if (!MUTATING.has(req.method)) return null;

  const headerToken = req.get("X-CSRF-Token") || "";
  const cookieToken = (req.cookies && req.cookies.csrfToken) || "";

  if (tokensMatch(headerToken, cookieToken)) return null;

  const detail = !cookieToken
    ? "no csrfToken cookie"
    : !headerToken
    ? "no X-CSRF-Token header"
    : "header/cookie mismatch";

  if (!isEnforced()) {
    // Monitor mode: visible in logs so the enforcement flip is data-driven.
    console.warn(
      `[CSRF] monitor: cookie-auth ${req.method} ${req.originalUrl || req.url} would be blocked (${detail})`
    );
    return null;
  }

  res.status(403).json({ error: "CSRF token missing or invalid." });
  return true;
}

module.exports = { csrfGuard, tokensMatch, MUTATING };
