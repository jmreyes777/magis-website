// middlewares/authenticateBranchAdmin.js

const admin = require("firebase-admin");
const { verifyJWT } = require("../utils/secretPool"); // worker-backed verifier

// Keep clock skew aligned with the rest of your stack (edge + backend worker)
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

/**
 * Middleware to authenticate Branch Admins using fallback (HMAC) or Firebase token.
 * Accepts token via Authorization header or Secure HTTP-only cookie.
 */
const authenticateBranchAdmin = async (req, res, next) => {
  try {
    let token;

    // 1) Prefer Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [scheme, credentials] = authHeader.split(" ");
      if (scheme !== "Bearer" || !credentials) {
        console.warn("[AUTH] Invalid Authorization header format.");
        return res
          .status(401)
          .json({ error: "Invalid token format. Expected Bearer token." });
      }
      token = credentials;
    }
    // 2) Fallback to cookie
    else if (req.cookies && req.cookies.branchAdminToken) {
      token = req.cookies.branchAdminToken;
      console.debug("[AUTH] Retrieved token from HTTP-only cookie.");
    }
    // 3) Fallback to a token in the JSON body (P3-4): for header-less calls such
    //    as navigator.sendBeacon (tab-close offline beacon), which cannot set an
    //    Authorization header and may not send the cookie cross-origin. The body
    //    is used INSTEAD OF a ?token= query param because query strings leak into
    //    access logs, browser history, proxy/CDN logs, and Referer headers.
    else if (req.body && typeof req.body.token === "string" && req.body.token) {
      token = req.body.token.trim();
    }
    // 4) No token available
    else {
      console.warn("[AUTH] No Authorization header or auth cookie present.");
      return res.status(401).json({ error: "Not authenticated. Please log in." });
    }

    let decoded;
    let isFallback = false;

    // 🟡 Try HMAC fallback token first (worker-backed; includes revocation + skew tolerance)
    try {
      decoded = await verifyJWT(token, {
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
      });

      if (decoded?.role === "branchadmin") {
        isFallback = true;
        console.log("[AUTH] ✅ Verified fallback token for:", decoded.email);
      } else {
        // Not a branchadmin HMAC token → force Firebase path
        throw new Error("Token is not branchadmin fallback");
      }
    } catch (fallbackErr) {
      // Map a revoked token to a clean 401
      if (fallbackErr && fallbackErr.message === "TokenRevoked") {
        console.warn("[AUTH] Token has been revoked (fallback).");
        return res
          .status(401)
          .json({ error: "Token has been revoked. Please log in again." });
      }

      // 🟢 If HMAC path fails for any other reason, try Firebase ID token
      try {
        // Note: Firebase Admin SDK handles its own clock tolerance internally.
        decoded = await admin.auth().verifyIdToken(token);
        console.log("[AUTH] ✅ Verified Firebase token for:", decoded.email);
      } catch (firebaseErr) {
        console.error("[AUTH] ❌ Both fallback and Firebase verification failed:", {
          fallbackError: fallbackErr?.message,
          firebaseError: firebaseErr?.message,
        });
        return res
          .status(401)
          .json({ error: "Invalid or expired token. Please log in again." });
      }
    }

    // ✅ Validate required claims for branch admins
    const role = decoded?.role;
    const email = (decoded?.email || decoded?.branchEmail || "").toLowerCase();
    const branchId = decoded?.branchId;
    const branchName = decoded?.branchName;

    if (role !== "branchadmin") {
      console.warn(`[AUTH] ❌ Unauthorized role: ${role}`);
      return res
        .status(403)
        .json({ error: "Access denied. Branch Admin role required." });
    }

    if (!branchId || !email || !branchName) {
      console.warn("[AUTH] ❌ Missing branch-specific fields in token payload.");
      return res
        .status(403)
        .json({ error: "Invalid token payload. Missing branch-specific details." });
    }

    // ✅ Attach branch info to request for downstream handlers
    req.branchId = branchId;
    req.branchEmail = email;
    req.branchName = branchName;
    req.user = decoded;

    console.info(
      `[AUTH] Branch Admin authenticated (${isFallback ? "fallback" : "firebase"}): ${email}`
    );

    return next();
  } catch (err) {
    console.error("[AUTH] Unexpected error during authentication:", err);
    return res
      .status(500)
      .json({ error: "An unexpected error occurred during authentication." });
  }
};

module.exports = authenticateBranchAdmin;
