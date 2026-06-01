// magis-project/backend/middlewares/authenticateSuperAdmin.js

const { verifyJWT } = require("../utils/secretPool"); // uses worker-backed verification
const jwt = require("jsonwebtoken"); // kept for error type references

// Consistent clock tolerance (seconds)
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

/**
 * Middleware to authenticate Super Admins using JWT.
 * Uses worker-backed verifyJWT (with Redis-based revocation support)
 * and enforces consistent skew tolerance across backend and edge layers.
 */
const authenticateSuperAdmin = async (req, res, next) => {
  try {
    // Step 1: Extract Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      console.warn("[AUTH] Missing Authorization header.");
      return res
        .status(401)
        .json({ error: "Authorization header is missing. Please log in." });
    }

    // Step 2: Extract Bearer token and validate format
    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      console.warn("[AUTH] Invalid token format.");
      return res
        .status(401)
        .json({ error: "Invalid token format. Expected Bearer token." });
    }

    // Step 3: Verify JWT token using worker-backed verifier (supports revocation)
    let decoded;
    try {
      decoded = await verifyJWT(token, {
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
      });
    } catch (error) {
      // Handle common JWT verification errors gracefully
      if (error.message === "TokenRevoked") {
        console.warn("[AUTH] Token has been revoked.");
        return res
          .status(401)
          .json({ error: "Token has been revoked. Please log in again." });
      }

      if (error.name === "TokenExpiredError") {
        console.warn("[AUTH] Token has expired.");
        return res
          .status(401)
          .json({ error: "Token has expired. Please log in again." });
      }

      if (
        error.name === "JsonWebTokenError" ||
        error.name === "NotBeforeError"
      ) {
        console.warn("[AUTH] Invalid token signature or format.");
        return res
          .status(401)
          .json({ error: "Invalid token. Please log in again." });
      }

      console.error("[AUTH] Unexpected verification error:", error);
      return res
        .status(500)
        .json({ error: "Internal verification error. Please try again." });
    }

    // Step 4: Ensure the token has the correct role ('superadmin')
    if (!decoded.role || decoded.role !== "superadmin") {
      console.warn(`[AUTH] Access denied. User role: ${decoded.role || "undefined"}`);
      return res
        .status(403)
        .json({ error: "Access denied. Super Admin role required." });
    }

    // Step 5: Attach relevant decoded details to the request object
    req.superAdminId = decoded.id || decoded.uid || decoded.sub;
    req.superAdminEmail = decoded.email?.toLowerCase?.() || "unknown@domain";

    console.info(
      `[AUTH] Super Admin authenticated. ID: ${req.superAdminId}, Email: ${req.superAdminEmail}`
    );

    // Step 6: Continue the request
    return next();
  } catch (error) {
    console.error("[AUTH] Unexpected error during authentication:", error);
    return res
      .status(500)
      .json({ error: "An unexpected error occurred during authentication." });
  }
};

module.exports = authenticateSuperAdmin;
