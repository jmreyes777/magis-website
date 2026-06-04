// index.js — hardened edge router for Magis website
// Minimal, in-code hardening (no new bindings required)
// Keeps your existing globalThis bindings: ADMIN_URL, GUEST_URL, BACKEND_URL, JWT_SECRET, RATE_LIMIT_KV (optional)

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK_TOLERANCE_SECONDS = 60;         // keep in sync with backend
const MAX_REQUESTS_PER_MINUTE = 60;         // soft default; auto-skips if RATE_LIMIT_KV missing

// JWT Verification using Web Crypto API
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
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = base64UrlDecode(signatureB64);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(data)
    );

    if (!valid) {
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
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// Clone the incoming request headers and explicitly forward the real client IP
// and Cloudflare-resolved country to the backend. These power the geolocation
// anomaly detection (international IP change mid-session) on the backend.
function withForwardedGeo(request) {
  const headers = new Headers(request.headers);
  // Strip any client-supplied copies first so they can never be spoofed; we set
  // authoritative values below.
  headers.delete("X-Geo-Country");
  headers.delete("X-Forwarded-For");
  headers.delete("X-Edge-Auth");

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const country =
    (request.cf && request.cf.country) ||
    request.headers.get("CF-IPCountry") ||
    "";
  if (ip) headers.set("X-Forwarded-For", ip);
  if (country && country !== "XX") headers.set("X-Geo-Country", country);
  // Authenticate this request to the backend as coming from the edge worker so
  // the backend only trusts forwarded geo headers from us (anti-spoofing).
  if (typeof EDGE_SHARED_SECRET === "string" && EDGE_SHARED_SECRET) {
    headers.set("X-Edge-Auth", EDGE_SHARED_SECRET);
  }
  return headers;
}

// ----- Allowlist derived from your existing globals + localhost -----
const { ADMIN_URL, GUEST_URL, BACKEND_URL, JWT_SECRET, RATE_LIMIT_KV, EDGE_SHARED_SECRET } = globalThis;
const ALLOWED_ORIGINS = [
  ADMIN_URL,
  GUEST_URL,
  "https://127.0.0.1:3000",
  "https://127.0.0.1:3001",
  "https://127.0.0.1:8787",
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
    // scripts
    "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://www.google.com https://apis.google.com https://www.googletagmanager.com https://maps.googleapis.com https://identitytoolkit.googleapis.com;",
    // styles
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;",
    // images (add FB CDNs)
    "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://storage.googleapis.com https://*.fbcdn.net https://lookaside.facebook.com;",
    // fonts
    "font-src 'self' https://fonts.gstatic.com;",
    // network connections (add Graph API)
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://www.googleapis.com https://maps.googleapis.com https://graph.facebook.com wss:;",
    // Facebook embeds
    "frame-src 'self' https://www.facebook.com https://m.facebook.com https://web.facebook.com https://connect.facebook.net https://staticxx.facebook.com;",
    // other security
    "object-src 'none'; base-uri 'self'; form-action 'self' mailto: https:;",
    // ✅ allow mailto and https navigations so clicking Email opens mail app/webmail
    "navigate-to 'self' mailto: https:;",
    "upgrade-insecure-requests;",
  ].join(" ");
}

function minimalResponse(
  body,
  status,
  origHeaders,
  { allowedOrigin, addCsp = false, isProdAsset = false } = {}
) {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    origHeaders.get("Content-Type") || "application/json"
  );
  const cc = origHeaders.get("Cache-Control");
  if (cc) headers.set("Cache-Control", cc);
  if (isProdAsset)
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  if (addCsp) headers.set("Content-Security-Policy", cspForSpa());
  addSecurityHeaders(headers);
  return new Response(body, { status, headers });
}

async function maybeRateLimit(ip) {
  // No config changes needed: if RATE_LIMIT_KV is not bound, skip.
  if (!RATE_LIMIT_KV) return true;
  try {
    const key = `rl::${ip}`;
    const raw = await RATE_LIMIT_KV.get(key);
    const count = Number(raw || 0);
    if (count >= MAX_REQUESTS_PER_MINUTE) return false;
    await RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 60 });
    return true;
  } catch {
    // Fail-open on KV errors (minimal tweak philosophy)
    return true;
  }
}

addEventListener("fetch", (event) =>
  event.respondWith(handle(event.request))
);

async function handle(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const origin = request.headers.get("Origin") || "";
  const host = request.headers.get("Host") || "";
  const allowedOrigin = isAllowedOrigin(origin) ? origin : "";
  const isLocal = isLocalHost(host);
  const isProd = !isLocal;

  // 0) Raw WebSocket upgrades → pass-through in prod
  if (request.headers.get("Upgrade") === "websocket") {
    if (isLocal) {
      return new Response(
        "WebSocket upgrade disabled in local dev. Connect directly to backend.",
        {
          status: 501,
          headers: addSecurityHeaders(
            new Headers({ "Content-Type": "text/plain" })
          ),
        }
      );
    }
    return fetch(new Request(`${BACKEND_URL}${pathname}${url.search}`, request));
  }

  // 1) Socket.IO (polling/ws) early path → pass-through
  if (pathname.startsWith("/socket.io")) {
    if (isLocal) {
      return new Response(
        "Socket.IO disabled in local dev (use direct backend URL).",
        {
          status: 501,
          headers: addSecurityHeaders(
            new Headers({ "Content-Type": "text/plain" })
          ),
        }
      );
    }
    const prox = new Request(`${BACKEND_URL}${pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
    });
    const resp = await fetch(prox);
    return minimalResponse(resp.body, resp.status, resp.headers, {
      allowedOrigin,
    });
  }

  // 2) SPA/static proxy (non-/api paths) with CSP + cache only
  if (!pathname.startsWith("/api")) {
    const target = pathname.startsWith("/admin") ? ADMIN_URL : GUEST_URL;
    const destUrl = target + pathname + url.search;

    // Scrub auth on static fetches
    const outHeaders = new Headers(request.headers);
    outHeaders.delete("Cookie");
    outHeaders.delete("Authorization");

    const resp = await fetch(destUrl, {
      method: request.method,
      headers: outHeaders,
      body: request.body,
      redirect: "follow",
    });

    const h = new Headers(resp.headers);
    if (isProd && isHashedAsset(pathname)) {
      h.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      h.set("Cache-Control", "no-cache");
    }
    h.set("Content-Security-Policy", cspForSpa());
    if (allowedOrigin) {
      h.set("Access-Control-Allow-Origin", allowedOrigin);
      h.set("Access-Control-Allow-Credentials", "true");
    }
    addSecurityHeaders(h);
    return new Response(resp.body, { status: resp.status, headers: h });
  }

  // 3) Lightweight API rate-limit (auto-skip if no KV)
  {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ok = await maybeRateLimit(ip);
    if (!ok) return new Response("Too Many Requests", { status: 429 });
  }

  // 4) CORS preflight
  if (request.method === "OPTIONS") {
    if (!allowedOrigin) return new Response("Forbidden", { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type,Authorization,X-CSRF-Token,X-Session-Id",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  // Enforce CORS
  if (origin && !allowedOrigin) {
    return new Response("Forbidden", { status: 403 });
  }

  // 5) Public/bypass endpoints (no JWT at edge)
  const isPublic =
    (request.method === "GET" &&
      pathname === "/api/facebook/latest-video") ||
    (request.method === "GET"  && pathname.startsWith("/api/facebook/albums/latest")) || // ✅ NEW: album route
    (request.method === "GET" &&
      pathname.startsWith("/api/branch-status")) ||
    (request.method === "POST" && pathname.startsWith("/api/guest")) ||
    (request.method === "POST" && pathname === "/api/messages/send") ||
    (request.method === "POST" && pathname === "/api/messages/start") ||
    // Guest fetches its own conversation key (guest token, role=user). The admin
    // GET variant carries a :guestId param and is verified via the admin path.
    (request.method === "POST" && pathname === "/api/messages/conversation-key") ||
    (request.method === "GET" &&
      pathname.startsWith("/api/messages/history")) ||
    // Guest read-receipt: guests hold a HS256 guest token (role=user), not a
    // branchadmin token, so the edge admin-JWT check would 401. The backend
    // route (authenticateGuest + per-message ACL) fully authenticates it.
    (request.method === "PATCH" &&
      pathname.startsWith("/api/messages/mark-seen-by-guest")) ||
    ((request.method === "GET" || request.method === "POST") && pathname === "/api/csrf-token") ||
    (request.method === "POST" && pathname === "/api/issue-fallback-token") ||
    // session-verify needs the Firebase RS256 ID token (fresh TOTP proof), which
    // the edge HS256 check would reject. The backend fully authenticates it
    // (Firebase verify + fresh-second-factor enforcement), so bypass here.
    (request.method === "POST" && pathname === "/api/mfa/session-verify");

  if (isPublic) {
    const backendReq = new Request(`${BACKEND_URL}${pathname}${url.search}`, {
      method: request.method,
      headers: withForwardedGeo(request),
      body: request.body,
      redirect: "follow",
    });
    const resp = await fetch(backendReq);
    return minimalResponse(resp.body, resp.status, resp.headers, {
      allowedOrigin,
    });
  }

  // 6) Admin JWT verification
  let token = request.headers.get("Authorization")?.split(" ")[1];
  if (!token) {
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((c) => c.split("=").map((s) => s.trim()))
        .filter(([k]) => k)
    );
    token = cookies.branchAdminToken;
  }

  if (!token) {
    const h = addSecurityHeaders(
      new Headers({ "Content-Type": "application/json" })
    );
    if (allowedOrigin) {
      h.set("Access-Control-Allow-Origin", allowedOrigin);
      h.set("Access-Control-Allow-Credentials", "true");
    }
    return new Response(
      JSON.stringify({ error: "Authorization token is required" }),
      { status: 401, headers: h }
    );
  }

  try {
    const { payload } = await verifyJWT(token, JWT_SECRET, {
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.role !== "branchadmin") {
      const h = addSecurityHeaders(
        new Headers({ "Content-Type": "application/json" })
      );
      if (allowedOrigin) {
        h.set("Access-Control-Allow-Origin", allowedOrigin);
        h.set("Access-Control-Allow-Credentials", "true");
      }
      return new Response(
        JSON.stringify({ error: "Forbidden: Branch Admins only" }),
        { status: 403, headers: h }
      );
    }
  } catch {
    const h = addSecurityHeaders(
      new Headers({ "Content-Type": "application/json" })
    );
    if (allowedOrigin) {
      h.set("Access-Control-Allow-Origin", allowedOrigin);
      h.set("Access-Control-Allow-Credentials", "true");
    }
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: h,
    });
  }

  // 7) Proxy protected API
  const proxied = new Request(`${BACKEND_URL}${pathname}${url.search}`, {
    method: request.method,
    headers: withForwardedGeo(request),
    body: request.body,
    redirect: "follow",
  });
  const resp = await fetch(proxied);
  return minimalResponse(resp.body, resp.status, resp.headers, {
    allowedOrigin,
  });
}
