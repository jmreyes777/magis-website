// server.js
const envPath = require("path").resolve(__dirname, "backend.env");
console.log("[SERVER] Loading env from:", envPath);
const dotenvResult = require("dotenv").config({ path: envPath });
console.log("[SERVER] dotenv loaded:", dotenvResult.parsed ? "YES" : "NO");
console.log("[SERVER] Parsed keys:", dotenvResult.parsed ? Object.keys(dotenvResult.parsed) : "NONE");
console.log("[SERVER] JWT_SECRET:", process.env.JWT_SECRET ? "set" : "not set"); // P2-4: presence only — never log key material

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const compression = require("compression");
const multer = require("multer");
const http = require("http");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");               // ← crypto for CSP nonces
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const jwt = require("jsonwebtoken");
const { signJWT, revokeJWT, verifyJWT } = require("./utils/secretPool");

// ⏱️ Align JWT skew + tighten lifetimes (defaults if not set in env)
process.env.JWT_CLOCK_SKEW_SEC = process.env.JWT_CLOCK_SKEW_SEC || "60";
process.env.JWT_TTL_MIN = process.env.JWT_TTL_MIN || "30";         // guests / short-lived
process.env.JWT_ADMIN_TTL_MIN = process.env.JWT_ADMIN_TTL_MIN || "240"; // admins/superadmins

// P2-4: superadmin allowlist is config-driven (SUPERADMIN_EMAILS, comma-separated).
// A legacy default is retained so an unconfigured deploy does not lock out the
// existing owner; set SUPERADMIN_EMAILS to manage it via config (and silence the
// warning). Firebase role:'superadmin' custom claims are still honored as well.
const SUPERADMIN_EMAILS = (process.env.SUPERADMIN_EMAILS || "jmreyes3167@gmail.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (!process.env.SUPERADMIN_EMAILS) {
  console.warn(
    "[SERVER] \u26a0\ufe0f SUPERADMIN_EMAILS not set \u2014 using a legacy default allowlist. Set SUPERADMIN_EMAILS to manage superadmins via config (P2-4)."
  );
}

// NEW (cluster-safe rate limiting)
const { RedisStore } = require("rate-limit-redis");
const { getRedis, isRedisConfigured } = require("./utils/redis");

// Use node-fetch if global fetch isn’t available (Node <18)
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import('node-fetch').then(({default: f}) => f(...args));
}
const fetch = fetchFn;

// --- Global Error Catchers for Process-Level Failures ---
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
// Redis-related rejections must NOT crash the process, but they must also NOT
// be silently hidden (P2-1): a swallowed error is precisely how rate-limiting
// and JWT revocation end up "inert in production" with nobody noticing. We keep
// the process alive but emit a throttled, explicit warning describing the
// security impact so the degradation is visible in logs.
let __lastRedisRejectionLogAt = 0;
process.on("unhandledRejection", (reason, p) => {
  const msg = reason && reason.message ? String(reason.message) : String(reason || "");
  const isRedisError =
    msg.includes("Connection is closed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("MaxRetriesPerRequestError") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ioredis");
  if (isRedisError) {
    const now = Date.now();
    if (now - __lastRedisRejectionLogAt > 60_000) {
      __lastRedisRejectionLogAt = now;
      console.error(
        "[redis] \u26a0\ufe0f Redis unreachable \u2014 rate-limiting & JWT revocation are DEGRADED " +
          "(failing open; per-instance/in-memory only). Provision REDIS_URL to restore. Last error:",
        msg
      );
    }
    return; // do not crash; degradation is logged (throttled) above
  }
  console.error("Unhandled Rejection:", reason);
});

// ── P2-1: Infra readiness self-check ────────────────────────────────────────
// In production/staging, Redis backs cluster-safe rate-limiting AND JWT
// revocation. If REDIS_URL is missing those controls silently degrade to
// per-instance/in-memory behavior. Make that loud, and optionally hard-fail
// when the operator opts in via REQUIRE_REDIS=true.
(function assertInfraReadiness() {
  const env = process.env.NODE_ENV;
  const isProdLike = env === "production" || env === "staging";
  const requireRedis = String(process.env.REQUIRE_REDIS || "").toLowerCase() === "true";

  if (isRedisConfigured()) {
    console.log(
      "[SERVER] \u2705 REDIS_URL configured \u2014 rate-limiting & JWT revocation are cluster-safe."
    );
    return;
  }

  if (isProdLike) {
    const banner = [
      "============================================================",
      "[SERVER] \u26a0\ufe0f  REDIS_URL is NOT set in a production/staging env.",
      "          Rate-limiting (login brute-force, guest abuse) and",
      "          JWT revocation (force-logout) will NOT work across",
      "          instances or survive restarts \u2014 the control is INERT.",
      "          \u2192 Provision managed Redis and set REDIS_URL.",
      "============================================================",
    ].join("\n");
    if (requireRedis) {
      console.error(banner);
      console.error("[SERVER] \u274c REQUIRE_REDIS=true \u2192 refusing to start without Redis.");
      process.exit(1);
    }
    console.error(banner);
  } else {
    console.log(
      "[SERVER] \u2139\ufe0f  No REDIS_URL (dev) \u2014 using localhost Redis if present, else in-memory fallbacks."
    );
  }
})();

const { db,admin } = require("./utils/firebase");
const { initializeSocket } = require("./utils/socket");
const { requireEdgeAuth, rateLimitKey } = require("./utils/geoSecurity");
const authenticateBranchAdmin = require("./middlewares/authenticateBranchAdmin");

const app = express();
// P3-2: pin `trust proxy` to the known proxy hop count instead of `true`. With
// `true`, Express trusts the ENTIRE X-Forwarded-For chain and req.ip becomes the
// left-most, client-controlled value — trivially spoofable to evade per-IP rate
// limits. TRUST_PROXY accepts an integer hop count (recommended in prod), the
// string "false" to disable, or a CSV of trusted IPs/CIDRs (Express-native).
// Default 1 (one trusted reverse proxy in front of Node). Rate-limit keys also
// prefer the edge-authenticated client IP (see rateLimitKey), so this value only
// governs req.ip on untrusted/fallback paths.
const parseTrustProxy = (raw) => {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return 1;
  const low = v.toLowerCase();
  if (low === "false") return false;
  if (low === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.includes(",") ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
};
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
console.log("[SERVER] trust proxy =", JSON.stringify(app.get("trust proxy")));
const PORT = process.env.PORT || 5000;
const fs   = require("fs");
const path = require("path");

// Use standard HTTP for Node.js 24 compatibility
let server;
server = http.createServer(app);
console.log(`[SERVER] HTTP/1.1 server listening at http://localhost:${PORT}`);

// ✅ Initialize Socket.IO and register it with Express
const io = initializeSocket(server);
app.set("socketio", io);
console.log("[SERVER] ✅ Socket.IO initialized and attached to Express")

// ✅ Set Backend API Base URL
const BASE_URL = process.env.BACKEND_URL || `https://localhost:${PORT}`;

// --- Middleware Setup (CORS) ---
// Parse FRONTEND_ORIGINS from either JSON array or CSV string.
const parseOrigins = (val = "") => {
  if (!val) return [];
  try {
    const arr = JSON.parse(val);
    if (Array.isArray(arr)) return arr.map((s) => String(s).trim()).filter(Boolean);
  } catch {}
  return val.split(",").map((s) => s.trim()).filter(Boolean);
};

const devOrigins = [
  "http://localhost:3000","https://localhost:3000",
  "http://localhost:3001","https://localhost:3001",
  "http://localhost:3002","https://localhost:3002",
  "http://localhost:4000","https://localhost:4000",
];
const prodOrigins = parseOrigins(process.env.FRONTEND_ORIGINS);
const allowedOrigins =
  process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging"
    ? prodOrigins
    : devOrigins;
console.log("[INFO] Allowed Origins:", allowedOrigins);

// Delegate so CORS can reflect the caller's origin (required when credentials:true).
const corsOptionsDelegate = (req, cb) => {
  const origin = req.headers.origin;
  // Allow non-browser calls (no Origin) and approved origins.
  const originAllowed = !origin || allowedOrigins.includes(origin);
  cb(null, {
    origin: originAllowed ? origin : false,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Session-Id"],
  });
};
app.use(cors(corsOptionsDelegate));

// ── PERF1-1: response compression (gzip/br) ────────────────────────────────
// Compresses API JSON + static assets at the origin, cutting payload size and
// the origin→edge transfer. Mounted early so it wraps all downstream responses.
// BREACH hardening: csurf already salts its token per request, but we still
// never compress the CSRF-token response (the token sits in the body), and we
// honor an `x-no-compression` opt-out for any future secret-bearing route that
// also reflects request input.
app.use(
  compression({
    threshold: 1024, // skip tiny payloads where overhead outweighs the benefit
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      if (req.path === "/api/csrf-token") return false; // BREACH: token in body
      return compression.filter(req, res);
    },
  })
);

// Strict preflight handler (no wildcard with credentials)
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || allowedOrigins[0] || "");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token,X-Session-Id");
    return res.sendStatus(204);
  }
  console.warn(`[WARNING] CORS PREFLIGHT BLOCKED: ${origin}`);
  return res.sendStatus(403);
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── P2-2: lock the API surface to the Cloudflare edge ───────────────────────
// Rejects (enforce) or logs (monitor) direct-to-origin /api requests that did
// NOT pass through the edge worker, closing the bypass of edge JWT/rate/geo
// controls. No-op until EDGE_SHARED_SECRET is set (see backend.env.example).
// Scoped to /api so /health probes and /socket.io are unaffected.
app.use("/api", requireEdgeAuth);

// ── INSERT HERE ────────────────────────────────────────────────────────────
// Create a standalone GET /api/csrf-token that _only_ runs through its own csurf
const csrfProtection = csurf({
  cookie: {
    key:      'csrfToken',
    httpOnly: false,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge:   60 * 60 * 1000,
  }
});

app.get(
  '/api/csrf-token',
  csrfProtection,
  (req, res) => {
    // sets a readable cookie _and_ returns the token in JSON
    res
      .cookie('csrfToken', req.csrfToken(), {
        httpOnly: false,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge:   60 * 60 * 1000,
      })
      .json({ csrfToken: req.csrfToken() });
  }
);

// ── PERF1-2: environment-gated HTTP request logging ─────────────────────────
// The verbose `dev` logger (per-request string building + stdout I/O on every
// request) is wasteful in production, where Cloudflare already records edge
// access logs. Non-prod keeps full `dev` logging for DX; prod samples a small
// fraction with the leaner `combined` format and never logs successful /health
// probes. Security-relevant audit logging lives elsewhere and is untouched.
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  const httpLogSample = Number(process.env.HTTP_LOG_SAMPLE || 0.05);
  app.use(
    morgan("combined", {
      skip: (req, res) =>
        (req.path === "/health" && res.statusCode < 400) ||
        Math.random() > httpLogSample,
    })
  );
}

// ── Advertise HTTP/3 (QUIC) via Alt-Svc header ──────────────────────────────
// Caddy already sets this at the proxy layer; this ensures it's also present
// on direct Node connections (e.g. local dev without Caddy).
app.use((req, res, next) => {
  res.setHeader("Alt-Svc", 'h3=":443"; ma=86400');
  // Allow Facebook SDK's use of the unload event (required for FB embeds/SDK).
  // All other Permissions-Policy features remain at browser default.
  res.setHeader("Permissions-Policy", "unload=(self \"https://connect.facebook.net\" \"https://www.facebook.com\" \"https://staticxx.facebook.com\")");
  next();
});

// ✅ Ensure JSON responses to prevent "Unexpected token '<'" errors
app.use((req, res, next) => {
  if (!req.headers["content-type"]?.startsWith("multipart/form-data")) {
    res.setHeader("Content-Type", "application/json");
  }
  next();
});

// ── Generate a fresh nonce for every request and expose it to views ──
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

// ✅ Update CSP for Security Enhancements, using per-request nonces
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        // allow mailto + https form submissions (e.g., contact/mail links in webmail)
        formAction: ["'self'", "mailto:", "https:"],
        frameAncestors: ["'none'"],

        scriptSrc: [
          "'self'",
          (req, res) => `'nonce-${res.locals.nonce}'`,
          "https://www.google.com",
          "https://www.gstatic.com",
          "https://maps.googleapis.com",
          "https://maps.gstatic.com",
          "https://apis.google.com",
          "https://identitytoolkit.googleapis.com",
          // Facebook SDK
          "https://connect.facebook.net",
          // Cloudflare Turnstile
          "https://challenges.cloudflare.com",
        ],
        scriptSrcElem: [
          "'self'",
          (req, res) => `'nonce-${res.locals.nonce}'`,
          "https://www.google.com",
          "https://www.gstatic.com",
          "https://maps.googleapis.com",
          "https://apis.google.com",
          "https://connect.facebook.net",
          "https://challenges.cloudflare.com",
        ],

        styleSrc: ["'self'", "https://fonts.googleapis.com"],

        imgSrc: [
          "'self'",
          "data:",
          "https://maps.googleapis.com",
          "https://maps.gstatic.com",
          "https://www.google.com",
          "https://storage.googleapis.com",
          // ✅ Facebook image CDNs for album photos
          "https://*.fbcdn.net",
          "https://lookaside.facebook.com",
        ],

        connectSrc: [
          "'self'",
          BASE_URL,
          "ws://localhost:5000",
          "wss://magis-website.firebaseapp.com",
          "http://localhost:5000",
          "https://identitytoolkit.googleapis.com",
          "https://firestore.googleapis.com",
          "https://maps.googleapis.com",
          "https://securetoken.googleapis.com",
          "https://www.googleapis.com",
          // ✅ Graph API for album/photos
          "https://graph.facebook.com",
          // Cloudflare Turnstile
          "https://challenges.cloudflare.com",
        ],

        fontSrc: ["'self'", "https://fonts.gstatic.com"],

        // ⬇️ Allow Facebook frames
        frameSrc: [
          "'self'",
          "https://www.facebook.com",
          "https://connect.facebook.net",
          "https://staticxx.facebook.com",
          "https://m.facebook.com/",
          "https://web.facebook.com",
          "https://challenges.cloudflare.com"
        ],

        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
        blockAllMixedContent: [],
        // ✅ Let the app navigate to its own pages + mailto + https (webmail)
        navigateTo: ["'self'", "mailto:", "https:"],
      },
    },
  })
);

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Routes
const messageRoutes = require("./routes/messages");
const guestRoutes = require("./routes/guest");
const analyticsRoutes = require("./routes/analytics");
const mfaRoutes = require("./routes/mfa");
// P1-4: per-IP throttle on guest-session creation — bot/abuse mitigation on the
// public /init endpoint. Redis-backed for multi-instance correctness (degrades
// to in-memory if Redis is down); tunable via env. NOTE: effectiveness depends
// on a trustworthy client IP — see P2-2 (lock origin to edge) / P3-2 (trust proxy).
const guestInitLimiter = rateLimit({
  windowMs: Number(process.env.GUEST_INIT_RL_WINDOW_MS) || 10 * 60 * 1000, // 10 min
  max: Number(process.env.GUEST_INIT_RL_MAX) || 20,                        // new sessions / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey, // P3-2: key on the edge-authenticated client IP
  message: { error: "Too many chat sessions from this network. Please wait a few minutes and try again." },
  store: new RedisStore({
    prefix: "rl:guest-init:",
    sendCommand: (...args) => getRedis().call(...args),
  }),
});
app.use("/api/guest/init", guestInitLimiter);

// P1-5: per-IP throttle on the public contact relay — anti-spam / open-relay
// abuse mitigation (in addition to authenticateGuest + server-resolved recipient).
const guestContactLimiter = rateLimit({
  windowMs: Number(process.env.GUEST_CONTACT_RL_WINDOW_MS) || 10 * 60 * 1000, // 10 min
  max: Number(process.env.GUEST_CONTACT_RL_MAX) || 5,                         // messages / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey, // P3-2: key on the edge-authenticated client IP
  message: { error: "Too many messages from this network. Please wait a few minutes and try again." },
  store: new RedisStore({
    prefix: "rl:guest-contact:",
    sendCommand: (...args) => getRedis().call(...args),
  }),
});
app.use("/api/guest/contact", guestContactLimiter);

app.use("/api/guest", guestRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/mfa", mfaRoutes);

// Login Rate Limiting (NOW using Redis store for multi-instance correctness)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  keyGenerator: rateLimitKey, // P3-2: key on the edge-authenticated client IP
  message: { error: "Too many login attempts. Please try again later." },
  headers: true,
  // Cluster-safe store backed by Redis:
  store: new RedisStore({
    // ioredis adapter: delegate commands to the shared client
    sendCommand: (...args) => getRedis().call(...args),
  }),
});
app.use("/api/branchadmin/login", loginLimiter);
app.use("/api/superadmin/login", loginLimiter);

// Super-Admin login handler (VERIFY Firebase ID token TOTP)
app.post("/api/superadmin/login", express.json(), async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: "idToken is required" });
  }

  try {
    // 1️⃣ Verify the Firebase ID token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const emailLower = (decoded.email || "").toLowerCase();

    // 2️⃣ Ensure they’re a superadmin (or the special allowed email)
    if (
      !SUPERADMIN_EMAILS.includes(emailLower) &&
      decoded.role !== "superadmin"
    ) {
      return res.status(403).json({ error: "Forbidden – not a Super Admin" });
    }

    // 3️⃣ Sign your backend JWT (HMAC) with whatever payload you need
    //    Use admin TTL from env (default 240m).
    const payload = {
      uid: decoded.uid,
      email: emailLower,
      role: "superadmin",
    };
    const backendToken = await signJWT(payload, {
      expiresIn: `${process.env.JWT_ADMIN_TTL_MIN}m`,
    });

    // 4️⃣ Set it as a Secure, HttpOnly cookie — match JWT lifetime
    res.cookie("superAdminToken", backendToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",                                   // ensure consistent clearing later
      maxAge: Number(process.env.JWT_ADMIN_TTL_MIN) * 60 * 1000, // ms
    });

    return res.status(200).json({ token: backendToken });
  } catch (err) {
    console.error("[API] ❌ Superadmin login error:", err);
    // Map Firebase errors to client‐friendly messages
    if (err.code === "auth/argument-error" || err.code === "auth/id-token-expired") {
      return res.status(401).json({ error: "Invalid or expired Firebase token" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Super-Admin logout → revoke cookie’s JTI and clear it
app.post("/api/superadmin/logout", async (req, res) => {
  const token = req.cookies.superAdminToken;
  if (token) {
    try {
      // Verify signature but ignore expiration to extract jti/exp for revocation.
      // Apply the same clock skew used elsewhere, if set.
      const clockTolerance = Number(process.env.JWT_CLOCK_SKEW_SEC || "60");
      const decoded = await verifyJWT(token, {
        ignoreExpiration: true,
        clockTolerance,           // seconds
      });
      if (decoded?.jti && decoded?.exp) {
        await revokeJWT({ jti: decoded.jti, expTimestamp: decoded.exp });
      }
    } catch (e) {
      // token invalid/expired — nothing to revoke, still clear cookie
    }
    // clear the cookie
    res.clearCookie("superAdminToken", {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
  }
  res.sendStatus(204);
});

app.post("/api/branchadmin/logout", async (req, res) => {
  try {
    const token = req.cookies.branchAdminToken;
    if (token) {
      const clockTolerance = Number(process.env.JWT_CLOCK_SKEW_SEC || "60");
      // Same approach: verify signature, ignore exp to safely gather jti/exp
      const payload = await verifyJWT(token, {
        ignoreExpiration: true,
        clockTolerance,
      });
      if (payload?.jti && payload?.exp) {
        await revokeJWT({ jti: payload.jti, expTimestamp: payload.exp });
      }
    }
    res.clearCookie("branchAdminToken", {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    return res.sendStatus(200);
  } catch (e) {
    console.error("[API] Branchadmin logout error:", e);
    return res.sendStatus(500);
  }
});


// ────────────────────────────────────────────────────────────────────────────
// Fallback (HMAC) token issuance — token EXCHANGE, not free minting.
// ----------------------------------------------------------------------------
// The Cloudflare edge can only verify our HS256 fallback tokens, not Firebase
// RS256 ID tokens, so authenticated admins exchange their proof of identity for
// a short-lived HMAC token used on every subsequent API/socket call.
//
// SECURITY (P0-1): this endpoint previously minted a full branchadmin token from
// nothing but a client-supplied `branchEmail` — an authentication bypass. It now
// REQUIRES verifiable proof of prior authentication and derives the identity from
// that proof (never from the request body):
//   1) A valid Firebase ID token (Authorization: Bearer <idToken> or body.idToken)
//      that resolves to a branchadmin — used at first login.
//   2) Rotation of an existing HMAC branchAdminToken (cookie / Authorization /
//      body.currentToken) that is still valid, or expired within
//      FALLBACK_REFRESH_GRACE_MIN, and not revoked — used for silent refresh.
// A caller with neither proof receives 401, closing the bypass.
// ────────────────────────────────────────────────────────────────────────────
const FALLBACK_TTL_MIN = Number(
  process.env.JWT_FALLBACK_TTL_MIN || process.env.JWT_ADMIN_TTL_MIN || "240"
);
const FALLBACK_REFRESH_GRACE_MIN = Number(
  process.env.FALLBACK_REFRESH_GRACE_MIN || "1440" // 24h: allow rotating a recently-expired token
);

// Resolve a branchadmin identity from a Firebase ID token, or null if the token
// is invalid/expired or the user is not a branch admin.
async function identityFromFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (_) {
    return null; // not a (currently-valid) Firebase token — caller may try HMAC proof
  }
  const email = (decoded.email || "").toLowerCase();
  let { role, branchId, branchName } = decoded;
  // Custom claims may not be embedded if they were assigned after this token was
  // minted; fall back to the authoritative user record.
  if (role !== "branchadmin" || !branchId || !branchName) {
    try {
      const userRecord = await admin.auth().getUser(decoded.uid);
      const claims = userRecord.customClaims || {};
      role = claims.role || role;
      branchId = claims.branchId || branchId;
      branchName = claims.branchName || branchName;
    } catch (_) {}
  }
  if (role !== "branchadmin" || !branchId || !email) return null;
  return { uid: decoded.uid, email, branchId, branchName: branchName || "Branch Admin", authVia: "firebase" };
}

// Resolve a branchadmin identity from an existing HMAC token for rotation. The
// worker verifier still enforces signature + revocation; we additionally bound
// how long after expiry a token may still be rotated.
async function identityFromHmacToken(token) {
  if (!token || typeof token !== "string") return null;
  let decoded;
  try {
    decoded = await verifyJWT(token, {
      algorithms: ["HS256"],
      ignoreExpiration: true, // allow recently-expired tokens to rotate (bounded below)
      clockTolerance: Number(process.env.JWT_CLOCK_SKEW_SEC || "60"),
    });
  } catch (_) {
    return null; // bad signature, revoked, or not our token
  }
  if (decoded.role !== "branchadmin" || !decoded.branchId || !decoded.email) return null;
  if (typeof decoded.exp === "number") {
    const expiredForSec = Math.floor(Date.now() / 1000) - decoded.exp;
    if (expiredForSec > FALLBACK_REFRESH_GRACE_MIN * 60) return null; // too stale to rotate
  }
  return {
    uid: decoded.uid || decoded.id,
    email: decoded.email.toLowerCase(),
    branchId: decoded.branchId,
    branchName: decoded.branchName || "Branch Admin",
    authVia: "rotation",
  };
}

app.post("/api/issue-fallback-token", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    // Candidate proofs. Both verifiers are tolerant and return null on mismatch,
    // so it is safe to try the bearer token as either kind.
    const idTokenCandidate = req.body.idToken || bearer;
    const hmacCandidate =
      req.body.currentToken || (req.cookies && req.cookies.branchAdminToken) || bearer;

    const identity =
      (await identityFromFirebaseIdToken(idTokenCandidate)) ||
      (await identityFromHmacToken(hmacCandidate));

    if (!identity) {
      console.warn("[FALLBACK_TOKEN] ❌ Rejected: no valid proof of prior authentication");
      return res.status(401).json({
        error: "Authentication required: provide a valid Firebase ID token or current admin token.",
      });
    }

    // If the client names a branch, it must match the authenticated identity.
    const requestedEmail = (req.body.branchEmail || "").toLowerCase();
    if (requestedEmail && requestedEmail !== identity.email) {
      console.warn(
        `[FALLBACK_TOKEN] ❌ branchEmail mismatch (requested=${requestedEmail}, identity=${identity.email})`
      );
      return res.status(403).json({ error: "branchEmail does not match authenticated identity." });
    }

    const payload = {
      uid: identity.uid,
      branchId: identity.branchId,
      email: identity.email,
      branchName: identity.branchName,
      role: "branchadmin",
      fallback: true,
      authVia: identity.authVia,
    };

    const token = await signJWT(payload, { expiresIn: `${FALLBACK_TTL_MIN}m` });

    // Secure, HTTP-only, partitioned cookie (lifetime matches the token).
    const cookie = [
      `branchAdminToken=${token}`,
      `Path=/`,
      `HttpOnly`,
      `Secure`,
      `SameSite=Strict`,
      `Partitioned`,
      `Max-Age=${FALLBACK_TTL_MIN * 60}`,
    ].join("; ");
    res.setHeader("Set-Cookie", cookie);

    console.info(`[FALLBACK_TOKEN] ✅ Issued (${identity.authVia}) for ${identity.email}`);
    return res.status(200).json({ token });
  } catch (err) {
    console.error("[FALLBACK_TOKEN] ❌ Error issuing fallback token:", err.message);
    return res.status(500).json({ error: "Token issuance failed" });
  }
});



// Offline status handler (sendBeacon support)
app.post(
  "/api/update-status",
  express.json(),
  authenticateBranchAdmin,
  async (req, res) => {
    try {
      // P2-5: only a verified branch admin may flip presence, and ONLY for
      // their OWN branch — the email comes from the token (req.branchEmail),
      // never the body, so nobody can mark an arbitrary branch offline.
      const email = (req.branchEmail || "").toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "Authenticated branch email missing" });
      }
      console.log(`[API] Marking ${email} as OFFLINE (tab closed)`);
      const branchStatusRef = db
        .collection("branchStatus")
        .doc(email);
      await branchStatusRef.set(
        { online: false, lastSeen: new Date().toISOString() },
        { merge: true }
      );
      res
        .status(200)
        .json({ success: true, message: `${email} marked offline` });
    } catch (error) {
      console.error("[ERROR] Failed to update offline status:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Branch-status public endpoint
const branchStatusRoutes = require("./routes/branchStatus");
app.use("/api", branchStatusRoutes);

// --- Facebook latest video with cache + rate limiter ---
const fbLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // allow more per minute per IP since caching protects Facebook
  keyGenerator: rateLimitKey, // P3-2: key on the edge-authenticated client IP
  message: { error: "Too many requests from this IP. Try again later." },
});

let cachedVideo = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

app.get("/api/facebook/latest-video", fbLimiter, async (req, res) => {
  const pageId = process.env.FB_PAGE_ID;
  const pageToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !pageToken) {
    return res.status(500).json({
      error: "Facebook credentials missing",
      details: {
        missing: [
          !pageId ? "FB_PAGE_ID" : null,
          !pageToken ? "FB_PAGE_ACCESS_TOKEN" : null,
        ].filter(Boolean),
      },
    });
  }

  // Serve cached result if recent enough
  if (cachedVideo && Date.now() - cachedAt < CACHE_TTL_MS) {
    return res.json({ video: cachedVideo });
  }

  const fetchJson = async (url) => {
    const r = await fetch(url);
    const txt = await r.text();
    let json;
    try {
      json = txt ? JSON.parse(txt) : {};
    } catch (e) {
      json = { parseError: e.message, raw: txt };
    }
    return { ok: r.ok, status: r.status, json };
  };

  const normalize = (v) =>
  v
    ? {
        id: v.id || null,
        embed_html: v.embed_html || null,
        permalink_url: v.permalink_url || null,
        creation_time: v.creation_time || v.created_time || null,
        thumbnail_url:
          Array.isArray(v?.thumbnails?.data) && v.thumbnails.data[0]?.uri
            ? v.thumbnails.data[0].uri
            : null,
      }
    : null;

  try {
    // Try LIVE first
    const liveUrl =
      `https://graph.facebook.com/v24.0/${encodeURIComponent(pageId)}/live_videos` +
      `?fields=id,embed_html,permalink_url,creation_time,created_time,status` + // ← no thumbnails here
      `&broadcast_status=["LIVE","LIVE_STOPPED","VOD"]` +
      `&limit=1&access_token=${encodeURIComponent(pageToken)}`;

        const live = await fetchJson(liveUrl);
        if (!live.ok) {
          const msg = live.json?.error?.message || `status ${live.status}`;
          console.warn("[FB live_videos warn]", msg);
        }

        const liveVideo =
          live.ok && Array.isArray(live.json?.data) ? live.json.data[0] : null;

        // If we have a live video (even without embed_html), use it
        let normalized = normalize(liveVideo);
        if (normalized && (normalized.embed_html || normalized.permalink_url)) {
          cachedVideo = normalized;
          cachedAt = Date.now();
          return res.json({ video: cachedVideo });
        }

    // Fallback to latest uploaded video
      const vidsUrl =
        `https://graph.facebook.com/v24.0/${encodeURIComponent(pageId)}/videos` +
        `?fields=id,embed_html,permalink_url,created_time,thumbnails{uri}` + // ← thumbnails OK here
        `&limit=1&access_token=${encodeURIComponent(pageToken)}`;

    const vids = await fetchJson(vidsUrl);
    if (!vids.ok) {
      console.error("[FB videos error]", { status: vids.status, body: vids.json });
      return res.status(502).json({
        error: "Facebook API error",
        upstreamStatus: vids.status,
        upstream: vids.json,
      });
    }

    const latest = Array.isArray(vids.json?.data) ? vids.json.data[0] : null;
    normalized = normalize(latest);

    // Only cache if we actually have something usable; avoid sticky null cache
    if (normalized && (normalized.embed_html || normalized.permalink_url)) {
      cachedVideo = normalized;
      cachedAt = Date.now();
    } else {
      cachedVideo = null;
      cachedAt = 0;
    }

    return res.json({ video: cachedVideo });
  } catch (err) {
    console.error("[FB FETCH EXCEPTION]", err);
    return res.status(500).json({
      error: "Facebook request failed",
      message: String(err?.message || err),
    });
  }
});


// --- Facebook LATEST ALBUM → PHOTOS (read-only), cached + rate-limited ---
const latestAlbumCache = { at: 0, albumId: null, photos: [] };
const LATEST_ALBUM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get("/api/facebook/albums/latest/photos", fbLimiter, async (req, res) => {
  const pageId = process.env.FB_PAGE_ID;
  const pageToken = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !pageToken) {
    return res.status(500).json({
      error: "Facebook credentials missing",
      details: {
        missing: [
          !pageId ? "FB_PAGE_ID" : null,
          !pageToken ? "FB_PAGE_ACCESS_TOKEN" : null,
        ].filter(Boolean),
      },
    });
  }

  // serve cache if fresh
  if (Date.now() - latestAlbumCache.at < LATEST_ALBUM_CACHE_TTL &&
      Array.isArray(latestAlbumCache.photos) &&
      latestAlbumCache.photos.length) {
    return res.json({
      albumId: latestAlbumCache.albumId,
      photos: latestAlbumCache.photos,
    });
  }

  const VERSION = "v24.0";
  try {
    // 1) get albums (id, name, created_time). Limit to e.g. 25 then we sort by created_time desc.
    const albumsUrl =
      `https://graph.facebook.com/${VERSION}/${encodeURIComponent(pageId)}/albums` +
      `?fields=id,name,created_time` +
      `&limit=25&access_token=${encodeURIComponent(pageToken)}`;
    const albumsRes = await fetch(albumsUrl);
    const albumsJson = await albumsRes.json();
    if (!albumsRes.ok) {
      console.error("[FB latest albums error]", albumsJson);
      return res.status(502).json({ error: "Facebook API error", upstream: albumsJson });
    }
    const albums = Array.isArray(albumsJson?.data) ? albumsJson.data : [];
    if (!albums.length) {
      return res.json({ albumId: null, photos: [] });
    }
    // sort by created_time desc (fallback if missing)
    albums.sort((a, b) => {
      const at = new Date(a.created_time || 0).getTime();
      const bt = new Date(b.created_time || 0).getTime();
      return bt - at;
    });
    const latestAlbum = albums[0];
    const albumId = latestAlbum.id;

    // 2) fetch photos in that album (like the other route)
    const fields = [
      "id",
      "name",
      "created_time",
      "permalink_url",
      "images{height,width,source}",
    ].join(",");
    const photosUrl =
      `https://graph.facebook.com/${VERSION}/${encodeURIComponent(albumId)}/photos` +
      `?fields=${encodeURIComponent(fields)}` +
      `&limit=100&access_token=${encodeURIComponent(pageToken)}`;

    const photosRes = await fetch(photosUrl);
    const photosJson = await photosRes.json();
    if (!photosRes.ok) {
      console.error("[FB latest album photos error]", photosJson);
      return res.status(502).json({ error: "Facebook API error", upstream: photosJson });
    }

    const norm = (Array.isArray(photosJson.data) ? photosJson.data : []).map((p) => ({
      id: p.id,
      caption: p.name || "",
      created_time: p.created_time || null,
      permalink_url: p.permalink_url || null,
      images: Array.isArray(p.images)
        ? p.images.map(({ source, width, height }) => ({ src: source, w: width, h: height }))
        : [],
    }));

    latestAlbumCache.at = Date.now();
    latestAlbumCache.albumId = albumId;
    latestAlbumCache.photos = norm;

    return res.json({ albumId, photos: norm });
  } catch (err) {
    console.error("[FB latest album exception]", err);
    return res.status(500).json({ error: "Facebook request failed", message: String(err?.message || err) });
  }
});


// Validate required env vars before listening
const requiredEnvVars = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "FRONTEND_ORIGINS",
  "JWT_SECRET",
];
requiredEnvVars.forEach((v) => {
  if (!process.env[v]) {
    console.error(`[ERROR] Environment variable ${v} is missing.`);
    process.exit(1);
  } else {
    console.log(`[INFO] Environment variable ${v} loaded.`);
  }
});


// Guest fallback force-close route
app.post("/api/guest/force-close", async (req, res) => {
  const io = app.get("socketio");
  const { guestId, branchEmail } = req.body;
  if (!guestId || !branchEmail) {
    return res.status(400).json({ error: "guestId and branchEmail are required" });
  }

  try {
    // 1️⃣ Archive their messages
    const messagesRef = db.collection("messages");
    const snapshot = await messagesRef
      .where("guestId", "==", guestId)
      .where("branchEmail", "==", branchEmail)
      .get();
    const batch = db.batch();
    snapshot.forEach((doc) => batch.update(doc.ref, { archived: true }));
    await batch.commit();

    // 2️⃣ Notify the branch-admin via WebSocket
    if (io) {
      io.to(`admin-${branchEmail}`).emit("chatClosed", { guestId });
      console.log(`[API] 📣 Emitted chatClosed to admin-${branchEmail}`);
    }

    // 3️⃣ Revoke the guest’s JWT
    const token = req.cookies.guestToken;
    if (token) {
      try {
        // decode without caring if it’s expired yet
        const payload = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
        await revokeJWT({ jti: payload.jti, expTimestamp: payload.exp });
      } catch (e) {
        console.warn("[API:FORCE_CLOSE] guestToken invalid or already expired:", e.message);
      }
    }

    // 4️⃣ Respond
    return res.status(200).json({ success: true, archivedCount: snapshot.size });
  } catch (err) {
    console.error("[API:FORCE_CLOSE] ❌ Error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

// Lightweight health check for load balancers / uptime probes.
// Registered before the static/catch-all so it always returns JSON 200.
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

//  — Serve React’s build —
const staticDir = path.join(__dirname, "build");
app.use(express.static(staticDir));

// Always return index.html for non-API routes (so client-side routing works)
app.get("/*", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

// Start server
server.listen(PORT);

// ── Graceful shutdown ────────────────────────────────────────────────────────
const gracefulShutdown = (signal) => {
  console.log(`[SERVER] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    console.log("[SERVER] HTTP server closed");
    try {
      const { getRedis } = require("./utils/redis");
      const redis = getRedis();
      if (redis && redis.status !== "end") await redis.quit();
      console.log("[SERVER] Redis connections closed");
    } catch (_) {}
    console.log("[SERVER] Shutdown complete");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[SERVER] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
