// index.js — hardened edge router for Magis website
// Minimal, in-code hardening (no new bindings required)
// Keeps your existing globalThis bindings: ADMIN_URL, GUEST_URL, BACKEND_URL, JWT_SECRET, RATE_LIMIT_KV (optional)

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK_TOLERANCE_SECONDS = 60;         // keep in sync with backend
const MAX_REQUESTS_PER_MINUTE = 60;         // soft default; auto-skips if RATE_LIMIT_KV missing

// JWT verification using Web Crypto API. P2-3: supports BOTH HS256 (verified
// with the shared secret) and RS256 (verified with the RSA PUBLIC key), chosen
// by the token's declared algorithm. Acceptance is presence-gated: HS256 is
// rejected when no JWT_SECRET is bound, RS256 is rejected when no JWT_PUBLIC_KEY
// is bound. After migration, remove JWT_SECRET from the worker so only RS256 is
// accepted and a compromised edge can no longer forge tokens.
async function verifyJWT(token, options = {}) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header and payload
    const header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
    const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));

    const data = `${headerB64}.${payloadB64}`;
    const signature = base64UrlDecode(signatureB64);

    // Verify the signature with the key that matches the declared algorithm. We
    // never verify an RS256 token with the HMAC secret, nor an HS256 token with
    // the public key (closes the alg-confusion downgrade-forgery attack).
    let valid = false;
    if (header.alg === 'RS256') {
      if (typeof JWT_PUBLIC_KEY !== 'string' || !JWT_PUBLIC_KEY) {
        throw new Error('RS256 not accepted (no public key bound)');
      }
      const key = await getRsaVerifyKey();
      valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        signature,
        encoder.encode(data)
      );
    } else if (header.alg === 'HS256') {
      if (typeof JWT_SECRET !== 'string' || !JWT_SECRET) {
        throw new Error('HS256 not accepted (no secret bound)');
      }
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );
      valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
    } else {
      throw new Error('Invalid algorithm');
    }

    if (!valid) {
      throw new Error('Invalid signature');
    }

    // Verify expiration only AFTER the signature is proven valid.
    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      const clockTolerance = options.clockTolerance || 0;
      if (payload.exp < now - clockTolerance) {
        throw new Error('Token expired');
      }
    }

    return { payload };
  } catch (error) {
    throw new Error(`JWT verification failed: ${error.message}`);
  }
}

// P2-3: import the RSA public key (SPKI PEM) once and cache the CryptoKey for
// RS256 verification. Tolerates PEM stored with literal "\n" (env-escaped).
let __rsaVerifyKeyPromise = null;
function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function getRsaVerifyKey() {
  if (!__rsaVerifyKeyPromise) {
    const pem = (typeof JWT_PUBLIC_KEY === 'string' ? JWT_PUBLIC_KEY : '').replace(/\\n/g, '\n');
    __rsaVerifyKeyPromise = crypto.subtle.importKey(
      'spki',
      pemToDer(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  }
  return __rsaVerifyKeyPromise;
}

function base64UrlDecode(base64Url) {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// P3-5 (edge): defense-in-depth iss/aud enforcement on the admin gate.
//
// The edge already verifies an admin token's SIGNATURE + expiry. This binds an
// accepted admin token to OUR issuer and the ADMIN audience (both stamped by
// the origin's secret worker), so a validly-signed token for another role,
// issuer, or deployment can't satisfy the edge admin gate.
//
// Mirrors the origin's JWT_VERIFY_CLAIMS rollout (set via wrangler [vars]):
//   monitor (default) → LOG mismatches, never block. Safe to ship immediately;
//                       enable enforce only AFTER the origin is in enforce so
//                       every live admin token already carries the claims.
//   enforce           → BLOCK tokens with wrong/missing iss or aud.
//   off               → skip the check entirely.
// `typeof` guards keep these safe when the optional [vars] are unbound.
const JWT_CLAIMS_MODE = (() => {
  const m =
    typeof JWT_VERIFY_CLAIMS !== "undefined"
      ? String(JWT_VERIFY_CLAIMS).toLowerCase()
      : "monitor";
  return m === "off" || m === "enforce" ? m : "monitor";
})();
const EXPECTED_ISSUER =
  typeof JWT_ISSUER !== "undefined" && JWT_ISSUER ? String(JWT_ISSUER) : "magis-api";
const EXPECTED_ADMIN_AUD =
  typeof JWT_AUD_ADMIN !== "undefined" && JWT_AUD_ADMIN
    ? String(JWT_AUD_ADMIN)
    : "magis-admin";

// Compare a decoded admin token to the iss/aud policy. Pure; never throws.
// aud may be a string or an array (RFC 7519); match either form.
function checkAdminClaims(payload) {
  const issues = [];
  if (EXPECTED_ISSUER && (!payload || payload.iss !== EXPECTED_ISSUER)) {
    issues.push(`iss(got=${payload && payload.iss},want=${EXPECTED_ISSUER})`);
  }
  const aud = payload && payload.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(EXPECTED_ADMIN_AUD)
    : aud === EXPECTED_ADMIN_AUD;
  if (EXPECTED_ADMIN_AUD && !audOk) {
    issues.push(`aud(got=${JSON.stringify(aud)},want=${EXPECTED_ADMIN_AUD})`);
  }
  return { ok: issues.length === 0, issues };
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
const { ADMIN_URL, GUEST_URL, BACKEND_URL, JWT_SECRET, RATE_LIMIT_KV, EDGE_SHARED_SECRET, JWT_PUBLIC_KEY } = globalThis;
const ALLOWED_ORIGINS = [
  ADMIN_URL,
  GUEST_URL,
  // Local dev origins (CRA's default scheme is http) — used when running the
  // admin frontend locally against this worker for staging testing.
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "https://127.0.0.1:3000",
  "https://127.0.0.1:3001",
  "https://127.0.0.1:8787",
].filter(Boolean);

const isLocalHost = (host) =>
  /(^localhost(:\d+)?$)|(^127\.0\.0\.1(:\d+)?$)/i.test(host || "");
const isHashedAsset = (p) =>
  /\.[0-9a-f]{8,}\.(js|css|png|jpe?g|gif|svg|webp|woff2?)$/i.test(p);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Any localhost / 127.0.0.1 origin (any port, http or https) — dev only. The
  // browser controls the Origin header and remote pages cannot forge it, so
  // permitting all local ports is safe and also covers IDE preview proxies that
  // bind to a random localhost port.
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
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

// Fresh, unpredictable per-request nonce (hex → safe in HTML attrs + CSP).
function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// P3-1: script-src is now nonce-based (no 'unsafe-inline'). Inline <script>s in
// the SPA carry the per-request nonce (substituted from the build placeholder),
// same-origin bundles match 'self', and third-party SDKs match the host list or
// read window.__CSP_NONCE. style-src KEEPS 'unsafe-inline' on purpose — React
// renders inline style="" attributes that nonces/hashes cannot cover, and style
// injection is a far lower risk than script injection.
//   - nonce set   → script-src 'self' 'nonce-<n>' <hosts>   (hardened, default)
//   - allowUnsafeInline → script-src 'self' 'unsafe-inline' <hosts> (legacy rollback)
//   - neither     → script-src 'self' <hosts>               (non-HTML assets)
function spaScriptSrc({ nonce = "", allowUnsafeInline = false } = {}) {
  const hosts =
    "https://connect.facebook.net https://www.google.com https://apis.google.com https://www.googletagmanager.com https://maps.googleapis.com https://identitytoolkit.googleapis.com https://challenges.cloudflare.com";
  const extra = allowUnsafeInline ? " 'unsafe-inline'" : nonce ? ` 'nonce-${nonce}'` : "";
  return `script-src 'self'${extra} ${hosts};`;
}

function cspForSpa(opts = {}) {
  return [
    "default-src 'self';",
    // scripts (P3-1: nonce-based; see spaScriptSrc)
    spaScriptSrc(opts),
    // styles
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;",
    // images (add FB CDNs)
    "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://storage.googleapis.com https://*.fbcdn.net https://lookaside.facebook.com;",
    // fonts
    "font-src 'self' https://fonts.gstatic.com;",
    // network connections (add Graph API)
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://www.googleapis.com https://maps.googleapis.com https://graph.facebook.com https://challenges.cloudflare.com wss:;",
    // Facebook embeds
    "frame-src 'self' https://www.facebook.com https://m.facebook.com https://web.facebook.com https://connect.facebook.net https://staticxx.facebook.com https://challenges.cloudflare.com;",
    // other security
    "object-src 'none'; base-uri 'self'; form-action 'self' mailto: https:;",
    // ✅ allow mailto and https navigations so clicking Email opens mail app/webmail
    "navigate-to 'self' mailto: https:;",
    "upgrade-insecure-requests;",
  ].join(" ");
}

// ─────────────────────────────────────────────────────────────────────
// Wave 4 (SEO): per-route <head> meta for non-JS crawlers + social scrapers.
//
// The SPA sets per-page <title>/description/Open Graph via react-helmet at
// runtime. Googlebot renders JS and sees them, but most SOCIAL scrapers
// (Facebook, X/Twitter, LinkedIn, Slack) do NOT run JS — they read the raw HTML
// only. Since this worker already rewrites the served HTML (for CSP nonces), we
// cheaply mirror the SAME per-route values into the STATIC tags so scrapers get
// correct titles, descriptions, share cards, and canonicals.
//
// Keep these in sync with each page's <Seo> component (user-frontend/src/pages).
// Unknown paths (deep SPA links, /admin, hashed assets) match nothing here and
// are returned untouched — they fall back to the static defaults baked into
// index.html plus the client-side <Seo>.
// ==== SEO-INJECT (start) ====
const SEO_ORIGIN = "https://www.magispawnshop.com";

const ROUTE_META = {
  "/": {
    title: "Magis Pawnshop & Jewelry | Instant Cash for Your Gold",
    description:
      "Trusted pawning, auctions, and jewelry sales since 1996. Get instant cash for your gold with high appraisals, low interest rates, and fast processing.",
  },
  "/branches": {
    title: "Pawnshop Branches Near You | Magis Gold & Gems",
    description:
      "Find a Magis pawnshop and jewelry branch near you — Angeles City, Pampanga and more. Addresses, opening hours, contact numbers, directions, and live chat.",
  },
  "/contact-us": {
    title: "Contact Us | Magis Gold & Gems Pawnshop",
    description:
      "Contact Magis Gold & Gems — message us or live-chat about pawning, jewelry, and branch services, including our contact number and customer service.",
  },
  "/faqs": {
    title: "FAQs: Pawning & Sangla | Magis Gold & Gems",
    description:
      "Answers on how to pawn (paano mag-sangla), requirements, how much you can pawn gold for, interest, redemption (tubos), appraisal, and BSP/AMLA rules.",
  },
  "/privacy-policy": {
    title: "Privacy Policy | Magis Gold & Gems Pawnshop",
    description:
      "How Magis Gold & Gems collects, uses, and protects your personal data under the Philippine Data Privacy Act (RA 10173), including your data subject rights.",
  },
  "/jewelry-sales": {
    title: "Gold Jewelry for Sale (Alahas) | Magis Gold & Gems",
    description:
      "Buy fine gold jewelry (alahas) in the Philippines — rings, necklaces, earrings and bracelets at fair, transparent prices, with layaway (hulugan) options.",
  },
  "/pawning": {
    title: "Pawn Gold & Jewelry (Sangla) | Magis Gold & Gems",
    description:
      "Pawn (sangla) your gold and jewelry for instant cash — see how much you can pawn 18k/21k gold for, with low interest, easy renewal and redemption. BSP-regulated.",
  },
  "/terms": {
    title: "Terms & Conditions | Magis Gold & Gems Pawnshop",
    description:
      "Terms governing use of the Magis Gold & Gems website, branch finder, and live chat, including BSP, AMLA, and Data Privacy Act (RA 10173) notices.",
  },
};

// Escape a value for safe embedding in an HTML attribute / text node. Inputs
// here are static + trusted; this is defense-in-depth so a stray character can
// never break out of the tag we build.
function seoEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Replace the FIRST match of `re` (non-global) with `replacement`. No match →
// return html unchanged. Never throws, never duplicates.
function seoReplaceFirst(html, re, replacement) {
  return re.test(html) ? html.replace(re, replacement) : html;
}

// Rewrite the static <head> to this route's title/description/OG/Twitter and add
// a canonical link. Any path not in ROUTE_META is returned unchanged.
function injectRouteMeta(html, pathname) {
  let key = pathname || "/";
  if (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1); // /x/ → /x
  const meta = ROUTE_META[key];
  if (!meta) return html;

  const title = seoEscape(meta.title);
  const description = seoEscape(meta.description);
  const canonical = key === "/" ? `${SEO_ORIGIN}/` : `${SEO_ORIGIN}${key}`;

  html = seoReplaceFirst(html, /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  html = seoReplaceFirst(
    html,
    /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${description}"/>`
  );
  html = seoReplaceFirst(
    html,
    /<meta property="og:title" content="[^"]*"\s*\/?>/,
    `<meta property="og:title" content="${title}"/>`
  );
  html = seoReplaceFirst(
    html,
    /<meta property="og:description" content="[^"]*"\s*\/?>/,
    `<meta property="og:description" content="${description}"/>`
  );
  html = seoReplaceFirst(
    html,
    /<meta property="og:url" content="[^"]*"\s*\/?>/,
    `<meta property="og:url" content="${canonical}"/>`
  );
  html = seoReplaceFirst(
    html,
    /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:title" content="${title}"/>`
  );
  html = seoReplaceFirst(
    html,
    /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:description" content="${description}"/>`
  );
  // The static HTML has no canonical (the SPA adds one at runtime). Add a static
  // one for scrapers — once, only if absent.
  if (!/rel="canonical"/.test(html)) {
    html = seoReplaceFirst(
      html,
      /<\/head>/,
      `<link rel="canonical" href="${canonical}"/></head>`
    );
  }
  return html;
}
// ==== SEO-INJECT (end) ====

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
  // If RATE_LIMIT_KV is not bound we have no store, so we cannot rate-limit —
  // skip. Bind the namespace (see wrangler.toml) to activate this control.
  // typeof guard avoids a ReferenceError when the binding is absent.
  if (typeof RATE_LIMIT_KV === "undefined" || !RATE_LIMIT_KV) return true;
  try {
    const key = `rl::${ip}`;
    const raw = await RATE_LIMIT_KV.get(key);
    const count = Number(raw || 0);
    if (count >= MAX_REQUESTS_PER_MINUTE) return false;
    await RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 60 });
    return true;
  } catch (e) {
    // KV is bound but erroring (P2-1). Default: fail-open so a transient KV blip
    // does not take the whole site down. Set RATE_LIMIT_FAIL_CLOSED="true" (a
    // [vars] entry in wrangler.toml) to block instead — stronger brute-force
    // protection, but a KV outage can then reject legitimate traffic.
    const failClosed =
      typeof RATE_LIMIT_FAIL_CLOSED !== "undefined" &&
      String(RATE_LIMIT_FAIL_CLOSED).toLowerCase() === "true";
    return failClosed ? false : true;
  }
}

addEventListener("fetch", (event) =>
  event.respondWith(handle(event.request, event))
);

// ── SPD1-1 (speed megaplan): keep-warm cron ──────────────────────────────────
// Render free-tier services spin down after ~15 min idle; the first visitor
// then waits 30-60s. A */10 cron ping keeps the backend (and its Firestore/
// Redis connections) warm for $0. Trigger is registered by deploy-api.mjs.
// Static hosts don't spin down, so only BACKEND_URL needs the ping.
addEventListener("scheduled", (event) => {
  event.waitUntil(keepWarm());
});

async function keepWarm() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      headers: { "User-Agent": "magis-edge-keepwarm" },
      signal: AbortSignal.timeout(50_000), // survive a cold start once
    });
    console.log(`[keep-warm] /health -> ${res.status}`);
  } catch (e) {
    console.log(`[keep-warm] failed: ${e.message}`);
  }
}

async function handle(request, event) {
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
    if (allowedOrigin) {
      h.set("Access-Control-Allow-Origin", allowedOrigin);
      h.set("Access-Control-Allow-Credentials", "true");
    }

    // P3-1: HTML documents are built with a placeholder nonce ("xyz123") on every
    // legitimate inline <script>/<style>, in the baked <meta> CSP, and in
    // window.__CSP_NONCE (which runtime SDK loaders read to tag dynamically
    // injected scripts). We swap that placeholder for a fresh, unpredictable
    // per-request nonce and emit a matching nonce-based CSP header WITHOUT
    // 'unsafe-inline', so an injected <script> can no longer execute by reusing a
    // guessable static nonce. Set CSP_MODE="legacy" (wrangler [vars]) to roll
    // back to the old unsafe-inline header + un-substituted nonce if ever needed.
    const cspMode =
      typeof CSP_MODE !== "undefined" ? String(CSP_MODE).toLowerCase() : "nonce";
    const isHtml = (resp.headers.get("Content-Type") || "").includes("text/html");

    if (isHtml && cspMode !== "legacy") {
      const nonce = generateNonce();
      let html = (await resp.text())
        .replaceAll('nonce="xyz123"', `nonce="${nonce}"`)
        .replaceAll("'nonce-xyz123'", `'nonce-${nonce}'`)
        .replaceAll('__CSP_NONCE="xyz123"', `__CSP_NONCE="${nonce}"`)
        .replaceAll('__CSP_NONCE = "xyz123"', `__CSP_NONCE = "${nonce}"`);
      // Wave 4 (SEO): mirror the SPA's per-route <head> meta into the static
      // HTML so non-JS social scrapers/crawlers get correct titles + cards.
      html = injectRouteMeta(html, pathname);
      h.set("Content-Security-Policy", cspForSpa({ nonce }));
      h.delete("Content-Length"); // body length changed by the substitution
      addSecurityHeaders(h);
      return new Response(html, { status: resp.status, headers: h });
    }

    // Non-HTML assets (or legacy rollback). CSP on an asset response governs
    // nothing, so this is effectively cosmetic except for the legacy fallback.
    h.set(
      "Content-Security-Policy",
      cspForSpa(cspMode === "legacy" ? { allowUnsafeInline: true } : {})
    );
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
    // Super-admin login token exchange (Firebase idToken in body -> backend
    // superadmin JWT). Like /api/issue-fallback-token it carries no prior edge
    // JWT, so it must be public; the backend verifies the Firebase token + the
    // superadmin allowlist. Required for the super-admin who manages staff.
    (request.method === "POST" && pathname === "/api/superadmin/login") ||
    // session-verify needs the Firebase RS256 ID token (fresh TOTP proof), which
    // the edge HS256 check would reject. The backend fully authenticates it
    // (Firebase verify + fresh-second-factor enforcement), so bypass here.
    (request.method === "POST" && pathname === "/api/mfa/session-verify") ||
    // ── Staff password + email-OTP module (additive) ─────────────────────────
    // Staff LOGIN flow is public (no token exists yet): the backend validates the
    // password, the emailed OTP, and the short-lived login ticket. Mirrors how the
    // existing admin login reaches the backend via /api/issue-fallback-token.
    // Covers /api/staff/login, /login/verify-otp, /login/resend-otp.
    (request.method === "POST" && pathname.startsWith("/api/staff/login")) ||
    // Super-admin STAFF MANAGEMENT (/api/admin/staff*): a superadmin token would be
    // 403'd by the edge's branchadmin gate below, so bypass the edge JWT here
    // exactly like /api/mfa/session-verify — the backend's authenticateSuperAdmin
    // fully authorizes it, and the edge still stamps X-Edge-Auth on the forwarded
    // request. (Staff /stepup/* and /change-password carry the branchadmin staff
    // token and intentionally pass through the normal admin gate, not this bypass.)
    (pathname.startsWith("/api/admin/staff")) ||
    // ── Branch login (email + password vs `branchAdmins` + emailed OTP) ───────
    // Public auth endpoints (no token exists yet): /login, /login/verify-otp,
    // /login/resend-otp, /forgot, /reset. The backend validates the password, the
    // emailed OTP, and the short-lived login ticket. (/api/branch/change-password
    // carries the branchadmin token and intentionally uses the normal gate below.)
    (request.method === "POST" && pathname.startsWith("/api/branch/login")) ||
    (request.method === "POST" && pathname === "/api/branch/forgot") ||
    (request.method === "POST" && pathname === "/api/branch/reset") ||
    // Passkey sign-in (Phase 5): same treatment as /api/branch/login above.
    // Enrollment/management (/api/webauthn/register*, /credentials*) stays on
    // the normal admin path below.
    (request.method === "POST" && pathname === "/api/webauthn/login-options") ||
    (request.method === "POST" && pathname === "/api/webauthn/login-verify") ||
    // SPD0-2 (speed megaplan): Web Vitals RUM beacons (sendBeacon, no auth,
    // 204-only responses; backend applies its own rate-limit bucket).
    (request.method === "POST" && pathname === "/api/rum") ||
    // Super-admin branch password management (/api/branch/admin*): a superadmin
    // token would be 403'd by the edge's branchadmin gate, so bypass like
    // /api/admin/staff — the backend's authenticateSuperAdmin authorizes it and
    // the edge still stamps X-Edge-Auth on the forwarded request.
    (pathname.startsWith("/api/branch/admin")) ||
    // Audit & compliance dashboard (/api/audit/*): a READ-ONLY API used by BOTH
    // super-admin and branch-admin. A superadmin token (role=superadmin) is
    // 403'd by the edge's branchadmin-only gate below, so bypass exactly like
    // /api/admin/staff — the backend's authenticateAuditViewer fully authorizes
    // BOTH roles (and scopes branch-admins to their own branchEmail). The edge
    // still stamps X-Edge-Auth on the forwarded request via withForwardedGeo.
    (pathname.startsWith("/api/audit")) ||
    // Logout endpoints must work even with no/expired edge token: the browser
    // calls them during teardown (idle auto-close, tab/page close) with only
    // credentials:'include' (no Authorization header), and the SameSite
    // branchAdminToken cookie is cross-site to this worker, so the admin JWT gate
    // would 401. They are safe to expose — the backend verifies the cookie itself
    // (allow-expired) to revoke the jti when present, then clears it (idempotent).
    (request.method === "POST" && pathname === "/api/branchadmin/logout") ||
    (request.method === "POST" && pathname === "/api/superadmin/logout") ||
    // Offline presence beacon (P3-4): authenticated by a token in the JSON BODY
    // (navigator.sendBeacon can't set an Authorization header, and the cookie is
    // not sent cross-site). The edge gate only reads header/cookie tokens, so it
    // must bypass here — exactly like /api/messages/conversation-key — and the
    // backend's authenticateBranchAdmin validates the body token and scopes the
    // offline flip to that token's OWN branch (never the body-supplied email).
    (request.method === "POST" && pathname === "/api/update-status");

  if (isPublic) {
    // PERF5-1: serve a small ALLOWLIST of public, NON-personalized GETs from the
    // Cloudflare edge cache, honoring the origin's s-maxage (set by PERF1-3).
    // Scoped to Facebook public content only. Everything else here — especially
    // /api/messages/history (per-guest private) and any token/cookie route — is
    // intentionally NEVER edge-cached.
    const edgeCacheable =
      request.method === "GET" &&
      (pathname === "/api/facebook/latest-video" ||
        pathname.startsWith("/api/facebook/albums/latest"));

    const cache = caches.default;
    // Key by the proxied URL only (GET, no headers) so a shared entry never
    // varies on Origin/Authorization. Per-request CORS is re-applied by
    // minimalResponse below, so the cached body is safe to reuse across origins.
    const cacheKey = new Request(`${BACKEND_URL}${pathname}${url.search}`, {
      method: "GET",
    });

    if (edgeCacheable) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return minimalResponse(cached.body, cached.status, cached.headers, {
          allowedOrigin,
        });
      }
    }

    const backendReq = new Request(`${BACKEND_URL}${pathname}${url.search}`, {
      method: request.method,
      headers: withForwardedGeo(request),
      body: request.body,
      redirect: "follow",
    });
    const resp = await fetch(backendReq);

    // Store only safe, publicly-cacheable 2xx bodies (no Set-Cookie). The Cache
    // API derives the edge TTL from the response's s-maxage/max-age.
    if (edgeCacheable && resp.status >= 200 && resp.status < 300) {
      const cc = resp.headers.get("Cache-Control") || "";
      if (
        !resp.headers.has("Set-Cookie") &&
        /public/i.test(cc) &&
        /(s-maxage|max-age)=\d+/i.test(cc)
      ) {
        // Best-effort: a cache.put rejection (size/header limits) must never
        // surface as an unhandled rejection or affect the live response.
        event.waitUntil(cache.put(cacheKey, resp.clone()).catch(() => {}));
      }
    }

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
    const { payload } = await verifyJWT(token, {
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

    // P3-5: defense-in-depth iss/aud check on the admin gate (monitor logs,
    // enforce blocks, off skips). Layered on top of the signature + role check
    // above so an admin route only accepts our-issued, admin-audience tokens.
    if (JWT_CLAIMS_MODE !== "off") {
      const { ok, issues } = checkAdminClaims(payload);
      if (!ok) {
        const detail = `[edge] admin JWT claim mismatch jti=${payload.jti || "?"}: ${issues.join("; ")}`;
        if (JWT_CLAIMS_MODE === "enforce") {
          console.warn(`${detail} — BLOCKED`);
          const h = addSecurityHeaders(
            new Headers({ "Content-Type": "application/json" })
          );
          if (allowedOrigin) {
            h.set("Access-Control-Allow-Origin", allowedOrigin);
            h.set("Access-Control-Allow-Credentials", "true");
          }
          return new Response(
            JSON.stringify({ error: "Invalid token issuer/audience" }),
            { status: 401, headers: h }
          );
        }
        console.warn(`${detail} — allowed (monitor)`);
      }
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
