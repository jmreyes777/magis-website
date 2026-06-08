// middlewares/authenticateGuest.js

const { verifyJWT } = require("../utils/secretPool");

// Keep skew tolerance consistent with Edge/Backend where applicable
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

module.exports = async function authenticateGuest(req, res, next) {
  let token;

  // 1) Prefer Authorization header (Bearer <token>)
  const authHeader = (req.headers.authorization || "").trim();
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();

  // 2) Fallback to HTTP-only cookie if present
  } else if (req.cookies && typeof req.cookies.guestToken === "string") {
    token = (req.cookies.guestToken || "").trim();

  // 3) Fallback to a token in the JSON body (P3-4): for header-less calls such
  //    as navigator.sendBeacon (tab-close force-close), which can't set an
  //    Authorization header. The body is used INSTEAD OF a ?token= query param
  //    because query strings leak into access logs, browser history, proxy/CDN
  //    logs, and outbound Referer headers.
  } else if (req.body && typeof req.body.token === "string") {
    token = (req.body.token || "").trim();

  // 4) No token provided
  } else {
    return res.status(401).json({ error: "Authentication required." });
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    // Worker-backed HS256 verify (includes revocation check)
    const payload = await verifyJWT(token, {
      algorithms: ["HS256"],
      clockTolerance: CLOCK_TOLERANCE_SEC,
    });

    // Basic shape/role validation for guests
    if (payload.role !== "user" || typeof payload.guestId !== "string") {
      throw new Error("Invalid guest token");
    }

    // Attach decoded payload for downstream middleware/routes
    req.user = payload;
    return next();

  } catch (err) {
    // Explicit revoke path → clean 401
    if (err && err.message === "TokenRevoked") {
      console.warn("[AUTH:Guest] Token revoked");
      return res.status(401).json({ error: "Token has been revoked. Please refresh." });
    }

    console.error("[AUTH:Guest] ❌", err?.message || err);
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};
