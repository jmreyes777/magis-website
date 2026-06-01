// dev-server.js - Local development server for edge worker
// This runs the edge worker logic locally for development purposes

require("dotenv").config({ path: ".env" });
const http = require("http");
const crypto = require("crypto");

// Configuration from .env
const ADMIN_URL = process.env.ADMIN_URL || "http://localhost:3001";
const GUEST_URL = process.env.GUEST_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET || "";
const PORT = process.env.EDGE_WORKER_PORT || 8787;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_REQUESTS_PER_MINUTE = 60;

const ALLOWED_ORIGINS = [
  ADMIN_URL,
  GUEST_URL,
  "https://127.0.0.1:3000",
  "https://127.0.0.1:3001",
  "https://127.0.0.1:8787",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:8787",
].filter(Boolean);

const isLocalHost = (host) =>
  /(^localhost(:\d+)?$)|(^127\.0\.0\.1(:\d+)?$)/i.test(host || "");
const isHashedAsset = (p) =>
  /\.[0-9a-f]{8,}\.(js|css|png|jpe?g|gif|svg|webp|woff2?)$/i.test(p);

function isAllowedOrigin(origin) {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

function addSecurityHeaders(h, { hsts = true } = {}) {
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
  );
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  if (hsts)
    h.set(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains; preload"
    );
  return h;
}

function cspForSpa() {
  return [
    "default-src 'self';",
    "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://www.google.com https://apis.google.com https://www.googletagmanager.com https://maps.googleapis.com https://identitytoolkit.googleapis.com;",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;",
    "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://storage.googleapis.com https://*.fbcdn.net https://lookaside.facebook.com;",
    "font-src 'self' https://fonts.gstatic.com;",
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://www.googleapis.com https://maps.googleapis.com https://graph.facebook.com wss:;",
    "frame-src 'self' https://www.facebook.com https://m.facebook.com https://web.facebook.com https://connect.facebook.net https://staticxx.facebook.com;",
    "object-src 'none'; base-uri 'self'; form-action 'self' mailto: https:;",
    "navigate-to 'self' mailto: https:;",
    "upgrade-insecure-requests;",
  ].join(" ");
}

// JWT Verification using Node.js crypto
async function verifyJWT(token, secret, options = {}) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header and payload
    const header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
    const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));

    // Verify algorithm
    if (header.alg !== 'HS256') {
      throw new Error('Invalid algorithm');
    }

    // Verify expiration
    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      const clockTolerance = options.clockTolerance || 0;
      if (payload.exp < now - clockTolerance) {
        throw new Error('Token expired');
      }
    }

    // Verify signature
    const data = `${headerB64}.${payloadB64}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(data);
    const expectedSignature = hmac.digest('base64url');

    if (signatureB64 !== expectedSignature) {
      throw new Error('Invalid signature');
    }

    return { payload };
  } catch (error) {
    throw new Error(`JWT verification failed: ${error.message}`);
  }
}

function base64UrlDecode(base64Url) {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

async function minimalResponse(
  body,
  status,
  origHeaders,
  { allowedOrigin, addCsp = false, isProdAsset = false } = {}
) {
  const headers = new Object();
  headers["Content-Type"] = origHeaders["content-type"] || "application/json";
  const cc = origHeaders["cache-control"];
  if (cc) headers["Cache-Control"] = cc;
  if (isProdAsset)
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  if (addCsp) headers["Content-Security-Policy"] = cspForSpa();
  addSecurityHeaders(headers);
  return { status, headers, body };
}

// Rate limiting (in-memory for development)
const rateLimitMap = new Map();

async function maybeRateLimit(ip) {
  const key = `rl::${ip}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  
  if (!entry) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  
  if (now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  
  if (entry.count >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }
  
  entry.count++;
  return true;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const origin = req.headers["origin"] || "";
  const host = req.headers["host"] || "";
  const allowedOrigin = isAllowedOrigin(origin) ? origin : "";
  const isLocal = isLocalHost(host);

  // WebSocket upgrades → pass-through
  if (req.headers["upgrade"] === "websocket") {
    if (isLocal) {
      const headers = addSecurityHeaders({});
      res.writeHead(501, { "Content-Type": "text/plain", ...headers });
      res.end("WebSocket upgrade disabled in local dev. Connect directly to backend.");
      return;
    }
    return proxyRequest(req, res, `${BACKEND_URL}${pathname}${url.search}`);
  }

  // Socket.IO (polling/ws) early path → pass-through
  if (pathname.startsWith("/socket.io")) {
    if (isLocal) {
      const headers = addSecurityHeaders({});
      res.writeHead(501, { "Content-Type": "text/plain", ...headers });
      res.end("Socket.IO disabled in local dev (use direct backend URL).");
      return;
    }
    return proxyRequest(req, res, `${BACKEND_URL}${pathname}${url.search}`);
  }

  // SPA/static proxy (non-/api paths) with CSP + cache
  if (!pathname.startsWith("/api")) {
    const target = pathname.startsWith("/admin") ? ADMIN_URL : GUEST_URL;
    const destUrl = target + pathname + url.search;
    return proxyRequest(req, res, destUrl, { allowedOrigin, addCsp: true, isLocal });
  }

  // API rate-limit
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
  const ok = await maybeRateLimit(ip);
  if (!ok) {
    res.writeHead(429, { "Content-Type": "text/plain" });
    res.end("Too Many Requests");
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    if (!allowedOrigin) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-CSRF-Token",
      "Access-Control-Allow-Credentials": "true",
    });
    res.end();
    return;
  }

  // Enforce CORS
  if (origin && !allowedOrigin) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // Public/bypass endpoints
  const isPublic =
    (req.method === "GET" && pathname === "/api/facebook/latest-video") ||
    (req.method === "GET" && pathname.startsWith("/api/facebook/albums/latest")) ||
    (req.method === "GET" && pathname.startsWith("/api/branch-status")) ||
    (req.method === "POST" && pathname.startsWith("/api/guest")) ||
    (req.method === "POST" && pathname === "/api/messages/send") ||
    (req.method === "POST" && pathname === "/api/messages/start") ||
    (req.method === "GET" && pathname.startsWith("/api/messages/history")) ||
    (req.method === "POST" && pathname === "/api/csrf-token") ||
    (req.method === "POST" && pathname === "/api/issue-fallback-token");

  if (isPublic) {
    return proxyRequest(req, res, `${BACKEND_URL}${pathname}${url.search}`, { allowedOrigin });
  }

  // Admin JWT verification
  let token = req.headers["authorization"]?.split(" ")[1];
  if (!token) {
    const cookieHeader = req.headers["cookie"] || "";
    const cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((c) => c.split("=").map((s) => s.trim()))
        .filter(([k]) => k)
    );
    token = cookies.branchAdminToken;
  }

  if (!token) {
    const headers = addSecurityHeaders({ "Content-Type": "application/json" });
    if (allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "Authorization token is required" }));
    return;
  }

  try {
    const { payload } = await verifyJWT(token, JWT_SECRET, {
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.role !== "branchadmin") {
      const headers = addSecurityHeaders({ "Content-Type": "application/json" });
      if (allowedOrigin) {
        headers["Access-Control-Allow-Origin"] = allowedOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
      }
      res.writeHead(403, headers);
      res.end(JSON.stringify({ error: "Forbidden: Branch Admins only" }));
      return;
    }
  } catch (err) {
    const headers = addSecurityHeaders({ "Content-Type": "application/json" });
    if (allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
    return;
  }

  // Proxy protected API
  return proxyRequest(req, res, `${BACKEND_URL}${pathname}${url.search}`, { allowedOrigin });
}

async function proxyRequest(req, res, targetUrl, options = {}) {
  const { allowedOrigin, addCsp = false, isLocal = false } = options || {};
  
  try {
    const url = new URL(targetUrl);
    const proxyReq = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      
      if (isLocal && isHashedAsset(url.pathname)) {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else if (isLocal) {
        headers["Cache-Control"] = "no-cache";
      }
      
      if (addCsp) {
        headers["Content-Security-Policy"] = cspForSpa();
      }
      
      if (allowedOrigin) {
        headers["Access-Control-Allow-Origin"] = allowedOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
      }
      
      addSecurityHeaders(headers);
      
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    
    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway' }));
    });
    
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway' }));
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`[EDGE WORKER DEV] Local development server running at http://localhost:${PORT}`);
  console.log(`[EDGE WORKER DEV] Proxying to backend at ${BACKEND_URL}`);
  console.log(`[EDGE WORKER DEV] Admin frontend at ${ADMIN_URL}`);
  console.log(`[EDGE WORKER DEV] Guest frontend at ${GUEST_URL}`);
});

server.on('error', (err) => {
  console.error('[EDGE WORKER DEV] Server error:', err);
});
