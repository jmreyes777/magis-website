// routes/branchadminauth.js

const express = require("express");
const router = express.Router();
const { db, assignCustomClaims, getCustomClaims } = require("../utils/firebase");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const { signJWT, verifyJWT } = require("../utils/secretPool"); // worker-backed
const { rateLimitKey } = require("../utils/geoSecurity"); // P3-2: trustworthy IP

// Memory/Firestore-backed lockout config
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

// Validate required environment variables
if (!process.env.JWT_SECRET) {
  console.error("[ERROR] Required environment variable JWT_SECRET is missing.");
  process.exit(1);
}

// Consistent clock-skew tolerance for JWT verification (seconds)
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

/**
 * Utility: Input Validation
 */
const validateInput = (value, fieldName) => {
  if (!value || typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid or missing ${fieldName}.`);
  }
  if (fieldName === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`Invalid email format.`);
  }
  if (fieldName === "password" && value.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
};

/**
 * Rate Limiting: Prevent Brute-Force Attacks
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: MAX_ATTEMPTS,
  keyGenerator: rateLimitKey, // P3-2: key on the edge-authenticated client IP
  message: { error: "Too many login attempts. Please try again later." },
  headers: true,
});

/**
 * POST /login
 * Branch Admin Login - Generates JWT Token with Account Lockout
 */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // Validate presence & format before using
    validateInput(email, "email");
    validateInput(password, "password");

    const sanitizedEmail = email.trim().toLowerCase();

    // Fetch lockout info from Firestore
    const adminRef = db.collection("branchAdmins").doc(sanitizedEmail);
    const adminSnapshot = await adminRef.get();
    const adminData = adminSnapshot.data() || {};

    if (!adminSnapshot.exists) {
      return handleFailedAttempt(sanitizedEmail, res, adminRef);
    }

    // Check if the account is locked
    if (adminData.lockedUntil && adminData.lockedUntil > Date.now()) {
      console.warn(`[SECURITY] Account locked for email: ${sanitizedEmail}`);
      return res
        .status(403)
        .json({ error: "Too many failed attempts. Try again later." });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, adminData.password);
    if (!isPasswordValid) {
      return handleFailedAttempt(sanitizedEmail, res, adminRef);
    }

    // Reset failed attempts on success
    await adminRef.update({
      failedAttempts: 0,
      lockedUntil: null,
    });

    // Retrieve and verify custom claims
    const claims = await getCustomClaims(adminSnapshot.id);
    if (!claims || claims.role !== "branchadmin") {
      console.warn(
        `[LOGIN] Access denied for email: ${sanitizedEmail} - Role mismatch`
      );
      return res
        .status(403)
        .json({ error: "Access denied. User is not a branch admin." });
    }
    if (!claims.branchId || !claims.branchName) {
      console.warn(
        `[LOGIN] Missing branch details for email: ${sanitizedEmail}`
      );
      return res
        .status(403)
        .json({ error: "Missing branch information in user claims." });
    }

    // Generate JWT via worker-thread (jti auto-injected by worker)
    const token = await signJWT(
      {
        id: adminSnapshot.id,
        email: adminData.email,
        branchId: claims.branchId,
        branchName: claims.branchName,
        role: claims.role,
      },
      { expiresIn: "8h" }
    );

    console.info(
      `[LOGIN] Branch Admin authenticated: ${sanitizedEmail} at ${new Date().toISOString()}`
    );

    // Set Secure HTTP-only cookie & return details
    res
      .cookie("branchAdminToken", token, {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/", // explicit for clarity/compat
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
      })
      .status(200)
      .json({
        message: "Login successful.",
        branchId: claims.branchId,
        branchEmail: adminData.email,
        branchName: claims.branchName,
      });
  } catch (error) {
    console.error(`[LOGIN] Error during Branch Admin login:`, error);
    return res
      .status(500)
      .json({ error: "Internal server error. Please try again later." });
  }
});

/**
 * Handle Failed Login Attempts with Firestore-Based Lockout
 */
async function handleFailedAttempt(email, res, adminRef) {
  const adminSnapshot = await adminRef.get();
  const adminData = adminSnapshot.exists ? adminSnapshot.data() : {};
  let failedAttempts = adminData.failedAttempts || 0;
  failedAttempts++;

  if (failedAttempts >= MAX_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCKOUT_DURATION;
    console.warn(`[SECURITY] Account locked due to failed attempts: ${email}`);
    await adminRef.set({ failedAttempts, lockedUntil }, { merge: true });
    return res
      .status(403)
      .json({ error: "Too many failed attempts. Try again later." });
  }

  await adminRef.set({ failedAttempts }, { merge: true });
  return res.status(401).json({ error: "Invalid credentials." });
}

/**
 * GET /profile
 * Retrieve Branch Admin Profile
 */
router.get("/profile", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token =
      authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res
        .status(401)
        .json({ error: "Authorization token is required." });
    }

    // Verify JWT via worker-thread with consistent skew tolerance
    const decoded = await verifyJWT(token, {
      algorithms: ["HS256"],
      clockTolerance: CLOCK_TOLERANCE_SEC,
    });

    const branchAdminRef = db.collection("branchAdmins").doc(decoded.id);
    const branchAdminSnapshot = await branchAdminRef.get();

    if (!branchAdminSnapshot.exists) {
      return res.status(404).json({ error: "Branch admin not found." });
    }

    console.info(
      `[PROFILE] Retrieved profile for Branch Admin: ${decoded.email}`
    );
    res.status(200).json({ profile: branchAdminSnapshot.data() });
  } catch (error) {
    console.error("[PROFILE] Error retrieving Branch Admin profile:", error);
    res.status(401).json({ error: "Invalid or expired token." });
  }
});

/**
 * POST /assign-branchadmin
 * Assign Custom Claims to a Branch Admin
 */
router.post("/assign-branchadmin", async (req, res) => {
  try {
    const { uid, branchId, branchName } = req.body;
    validateInput(uid, "User ID");
    validateInput(branchId, "Branch ID");
    validateInput(branchName, "Branch Name");

    await assignCustomClaims(uid, {
      role: "branchadmin",
      branchId,
      branchName,
    });
    console.info(`[CLAIMS] Assigned Branch Admin role to user: ${uid}`);
    return res
      .status(200)
      .json({ message: `User ${uid} successfully assigned as branchadmin.` });
  } catch (error) {
    console.error("[CLAIMS] Error assigning custom claims:", error);
    res.status(500).json({ error: "Failed to assign custom claims." });
  }
});

module.exports = router;
