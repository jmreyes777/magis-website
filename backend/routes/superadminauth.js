// magis-project/backend/routes/superadminauth.js

const express = require("express");
const router = express.Router();
const { db, assignCustomClaims, getCustomClaims } = require("../utils/firebase");
const admin = require("firebase-admin"); // Firebase Admin SDK

// ✅ Use the worker-based pool for JWT operations
const { signJWT, verifyJWT } = require("../utils/secretPool");

// Validate required environment variables
if (!process.env.JWT_SECRET) {
  console.error("[ERROR] JWT_SECRET is not defined in environment variables.");
  process.exit(1);
}

// Small helper for consistent clock-skew tolerance (default: 30s)
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

/**
 * Utility function to validate input fields
 * @param {string} value - Input value
 * @param {string} fieldName - Field name for error reference
 */
const validateInput = (value, fieldName) => {
  if (!value || typeof value !== "string") {
    throw new Error(`Invalid or missing ${fieldName}.`);
  }
};

/**
 * Centralized error handler to avoid redundant code
 * @param {Response} res - Express response object
 * @param {Error} error - Error object
 * @param {string} context - Contextual message for error logs
 */
const handleErrorResponse = (res, error, context) => {
  console.error(`[ERROR] ${context}:`, error && error.message ? error.message : error);

  // Preserve your original behavior:
  // - 401 when token is expired
  // - 500 for unexpected errors (keep messages token-focused if applicable)
  const statusCode = error && error.name === "TokenExpiredError" ? 401 : 500;
  const message =
    error && typeof error.message === "string" && error.message.includes("Token")
      ? error.message
      : "An unexpected server error occurred.";
  return res.status(statusCode).json({ error: message });
};

/**
 * POST /api/superadmin/login
 * Description: Authenticates Super Admin and generates a JWT with role: superadmin
 */
router.post("/login", async (req, res) => {
  try {
    const { email } = req.body;

    // Input validation
    validateInput(email, "email");
    console.info(`[LOGIN] Super Admin login attempt: ${email}`);

    // Step 1: Verify user exists in Firebase Authentication
    const userRecord = await admin.auth().getUserByEmail(email);
    if (!userRecord) {
      console.warn(`[LOGIN] No user found in Firebase Authentication for email: ${email}`);
      return res.status(404).json({ error: "User not found." });
    }

    // Step 2: Verify 'superadmin' role in custom claims
    const claims = await getCustomClaims(userRecord.uid);
    if (!claims || claims.role !== "superadmin") {
      console.warn(`[LOGIN] Unauthorized access attempt by ${email}. Claims:`, claims);
      return res.status(403).json({ error: "Access denied. Not a superadmin." });
    }

    // Step 3: Generate JWT token via worker (injects jti automatically)
    // Keep your existing 2h lifetime to avoid breaking clients.
    const token = await signJWT(
      {
        id: userRecord.uid,
        email: userRecord.email,
        role: "superadmin",
      },
      { expiresIn: "2h" }
    );

    console.info(`[LOGIN] Super Admin authenticated successfully: ${email}`);
    return res.status(200).json({ message: "Login successful.", token });
  } catch (error) {
    handleErrorResponse(res, error, "Super Admin Login");
  }
});

/**
 * POST /api/superadmin/assign-superadmin
 * Description: Assigns the 'superadmin' role to a specified user in Firebase.
 */
router.post("/assign-superadmin", async (req, res) => {
  try {
    const { uid } = req.body;

    // Input validation
    validateInput(uid, "user ID");
    console.info(`[ASSIGN-SUPERADMIN] Assigning 'superadmin' role to UID: ${uid}`);

    // Assign 'superadmin' role using custom claims
    await assignCustomClaims(uid, { role: "superadmin" });

    console.info(`[ASSIGN-SUPERADMIN] Role successfully assigned to user: ${uid}`);
    return res.status(200).json({ message: `User ${uid} assigned as superadmin.` });
  } catch (error) {
    handleErrorResponse(res, error, "Assign Super Admin Role");
  }
});

/**
 * GET /api/superadmin/verify
 * Description: Verifies the validity of the Super Admin's JWT token.
 */
router.get("/verify", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    // Validate token presence
    if (!token) {
      console.warn("[VERIFY] Missing authorization token.");
      return res.status(401).json({ error: "Authorization token is required." });
    }

    // Verify and decode the token via worker (consistent skew tolerance)
    const decoded = await verifyJWT(token, {
      // Default worker verify respects exp; add tolerance for minor drift
      clockTolerance: CLOCK_TOLERANCE_SEC,
    });

    // Check for 'superadmin' role
    if (decoded.role !== "superadmin") {
      console.warn(`[VERIFY] Unauthorized role: ${decoded.role}`);
      return res.status(403).json({ error: "Access denied. Super Admin role required." });
    }

    console.info(`[VERIFY] Token valid for Super Admin: ${decoded.email}`);
    return res.status(200).json({ message: "Token is valid.", role: decoded.role });
  } catch (error) {
    handleErrorResponse(res, error, "Verify Super Admin Token");
  }
});

module.exports = router;
