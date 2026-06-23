// backend/middlewares/authenticateAuditViewer.js
//
// Combined authenticator for the audit dashboard read API. Accepts EITHER a
// super-admin or a branch-admin session (HMAC fallback token or Firebase ID
// token, same shapes the existing per-role middlewares accept) and normalizes
// the result onto `req.audit` so the route can apply role-based scoping:
//
//   req.audit = {
//     role: 'superadmin' | 'branchadmin',
//     isSuper: boolean,
//     email, id,
//     branchEmail,        // null for super-admin
//     branchId, branchName,
//   }
//
// This middleware does NOT mutate any existing middleware/route — it is purely
// additive and isolated to the /api/audit surface.

const admin = require("firebase-admin");
const { verifyJWT } = require("../utils/secretPool");

const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

module.exports = async function authenticateAuditViewer(req, res, next) {
  try {
    // 1) Extract token: Authorization: Bearer <t> (super-admin + branch-admin),
    //    or the branchAdminToken HTTP-only cookie (branch-admin).
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [scheme, creds] = authHeader.split(" ");
      if (scheme !== "Bearer" || !creds) {
        return res.status(401).json({ error: "Invalid token format. Expected Bearer token." });
      }
      token = creds;
    } else if (req.cookies && req.cookies.branchAdminToken) {
      token = req.cookies.branchAdminToken;
    } else {
      return res.status(401).json({ error: "Not authenticated. Please log in." });
    }

    // 2) Verify: try the worker-backed HMAC verifier first (covers both
    //    super-admin and branch-admin fallback tokens, incl. revocation), then
    //    fall back to a Firebase ID token (branch-admin Firebase session).
    let decoded;
    try {
      decoded = await verifyJWT(token, {
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
      });
    } catch (err) {
      if (err && err.code === "EWORKERBUSY") {
        return res.status(503).json({ error: "Service busy. Please retry shortly." });
      }
      if (err && err.message === "TokenRevoked") {
        return res.status(401).json({ error: "Token has been revoked. Please log in again." });
      }
      try {
        decoded = await admin.auth().verifyIdToken(token);
      } catch (fbErr) {
        return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
      }
    }

    // 3) Authorize: only super-admin or branch-admin may read the audit trail.
    const role = decoded?.role;
    if (role !== "superadmin" && role !== "branchadmin") {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const email = (decoded?.email || decoded?.branchEmail || "").toLowerCase();
    const isSuper = role === "superadmin";

    if (!isSuper && !email) {
      return res.status(403).json({ error: "Invalid token payload. Missing branch identity." });
    }

    req.audit = {
      role,
      isSuper,
      email: email || null,
      id: decoded?.id || decoded?.uid || decoded?.sub || null,
      branchEmail: isSuper ? null : email,
      branchId: decoded?.branchId || null,
      branchName: decoded?.branchName || null,
    };

    return next();
  } catch (e) {
    console.error("[AUDIT-AUTH] Unexpected error:", e?.message || e);
    return res.status(500).json({ error: "An unexpected error occurred during authentication." });
  }
};
