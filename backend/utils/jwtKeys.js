// backend/utils/jwtKeys.js
//
// P2-3: central JWT signing/verification key + algorithm policy.
//
// Goal: move off a single SYMMETRIC HS256 secret shared by the Cloudflare edge
// and the origin (where compromise of either forges tokens for all roles) to
// ASYMMETRIC RS256 — the backend (origin) holds the PRIVATE key and signs; the
// edge holds only the PUBLIC key and verifies. Compromising the edge then can
// never mint tokens.
//
// Safe-by-default + rollout-friendly:
//   - JWT_ALG defaults to "HS256" → behavior is identical to before until an
//     operator provisions keys and flips JWT_ALG=RS256.
//   - During the transition we VERIFY both RS256 and HS256 so tokens issued just
//     before the cutover keep working until they expire. Set JWT_ACCEPT_HS256=
//     false once the longest TTL (admin, ~4h) has elapsed to finish the cutover.
//
// Alg-confusion safety: the verification key is chosen from the token's declared
// `alg`, but ONLY among algorithms we explicitly accept, and an RS256 token is
// ALWAYS verified with the RSA public key while an HS256 token is ALWAYS verified
// with the HMAC secret. We never feed the public key in as an HMAC secret, which
// is the classic RS256→HS256 downgrade-forgery vector.

const jwt = require("jsonwebtoken");

// Env stores PEM keys with literal "\n"; restore real newlines (matches the
// existing FIREBASE_PRIVATE_KEY handling in utils/firebase.js).
function normalizePem(v) {
  if (!v || typeof v !== "string") return "";
  return v.includes("\\n") ? v.replace(/\\n/g, "\n") : v;
}

const JWT_ALG =
  String(process.env.JWT_ALG || "HS256").toUpperCase() === "RS256" ? "RS256" : "HS256";
const JWT_SECRET = process.env.JWT_SECRET || "";
const PRIVATE_KEY = normalizePem(process.env.JWT_PRIVATE_KEY);
const PUBLIC_KEY = normalizePem(process.env.JWT_PUBLIC_KEY);
// Keep accepting HS256 during the migration window. Default true so flipping
// JWT_ALG=RS256 does not instantly reject in-flight HS256 tokens.
const ACCEPT_HS256 =
  String(process.env.JWT_ACCEPT_HS256 || "true").toLowerCase() !== "false";

// ─────────────────────────────────────────────────────────────────────────────
// P3-5: issuer (iss) + audience (aud) claim policy.
//
// Goal: bind every token we mint to a known ISSUER and to a role-specific
// AUDIENCE, then verify both — so a token minted for one role can't be replayed
// against another, and a token from a different issuer/deployment (or a leaked
// shared secret used by another service) is rejected.
//
// Rollout-safe, mirrors the RS256 / edge-auth pattern:
//   JWT_VERIFY_CLAIMS = monitor | enforce | off   (default: monitor)
//     monitor → SIGN iss/aud + LOG mismatches, never reject (safe default)
//     enforce → SIGN iss/aud + REJECT tokens with wrong/missing iss or aud
//     off     → don't check claims at all (claims are still SIGNED in)
// Tokens are ALWAYS signed with iss/aud, so the claims exist before enforcement.
// Flip to "enforce" only AFTER the longest token TTL (branch-admin login = 8h)
// has elapsed post-deploy, so pre-rollout tokens (which lack the claims) have
// all expired. The aud is checked for consistency with the token's OWN role —
// every token we mint carries a role — which, combined with each endpoint's
// existing role check, means an endpoint effectively only accepts tokens whose
// audience matches that role.
const JWT_ISSUER = process.env.JWT_ISSUER || "magis-api";
const JWT_AUD_DEFAULT = process.env.JWT_AUDIENCE || "magis-api";
const AUDIENCES = {
  user: process.env.JWT_AUD_GUEST || "magis-guest",
  branchadmin: process.env.JWT_AUD_ADMIN || "magis-admin",
  superadmin: process.env.JWT_AUD_SUPERADMIN || "magis-superadmin",
};
const VERIFY_CLAIMS_MODE = (() => {
  const m = String(process.env.JWT_VERIFY_CLAIMS || "monitor").toLowerCase();
  return m === "off" || m === "enforce" ? m : "monitor";
})();

/** Map a token's role claim to its expected audience (default for unknown). */
function audienceForRole(role) {
  return (role && AUDIENCES[role]) || JWT_AUD_DEFAULT;
}

/** aud may be a string or an array (RFC 7519); match either form. */
function audienceMatches(tokenAud, expected) {
  if (Array.isArray(tokenAud)) return tokenAud.includes(expected);
  return tokenAud === expected;
}

/**
 * Compare a decoded token's iss/aud against policy. Pure (never throws); returns
 * { ok, issues }. Callers decide whether to reject (enforce) or just log.
 */
function checkClaims(decoded) {
  const issues = [];
  if (JWT_ISSUER && (!decoded || decoded.iss !== JWT_ISSUER)) {
    issues.push(`iss(got=${decoded ? decoded.iss : undefined},want=${JWT_ISSUER})`);
  }
  const expectedAud = audienceForRole(decoded && decoded.role);
  if (expectedAud && !(decoded && audienceMatches(decoded.aud, expectedAud))) {
    issues.push(`aud(got=${JSON.stringify(decoded && decoded.aud)},want=${expectedAud})`);
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Apply the claim policy: throw "InvalidClaims" in enforce, warn in monitor,
 * no-op in off. A throw here is handled exactly like any other verification
 * failure upstream (→ 401), so enforcement degrades safely.
 */
function enforceClaims(decoded, ctx = "") {
  if (VERIFY_CLAIMS_MODE === "off") return;
  const { ok, issues } = checkClaims(decoded);
  if (ok) return;
  const msg = `JWT claim mismatch ${ctx ? `(${ctx}) ` : ""}jti=${(decoded && decoded.jti) || "?"}: ${issues.join("; ")}`;
  if (VERIFY_CLAIMS_MODE === "enforce") {
    const err = new Error("InvalidClaims");
    err.detail = msg;
    throw err;
  }
  console.warn(`[jwtKeys] (claims monitor) ${msg}`);
}

/** Signing-side policy (issuer + role→audience) consumed by the secret worker. */
function getClaimsPolicy() {
  return {
    issuer: JWT_ISSUER,
    mode: VERIFY_CLAIMS_MODE,
    audienceForRole,
    audiences: AUDIENCES,
    defaultAudience: JWT_AUD_DEFAULT,
  };
}

/**
 * Signing key + algorithm. Throws a clear error if the required key is missing
 * so misconfiguration fails loudly (rather than silently signing with a default).
 */
function getSigningParams() {
  if (JWT_ALG === "RS256") {
    if (!PRIVATE_KEY) {
      throw new Error("JWT_ALG=RS256 but JWT_PRIVATE_KEY is not set");
    }
    return { key: PRIVATE_KEY, algorithm: "RS256" };
  }
  if (!JWT_SECRET) {
    throw new Error("JWT_ALG=HS256 but JWT_SECRET is not set");
  }
  return { key: JWT_SECRET, algorithm: "HS256" };
}

/**
 * Choose the verification key for a token based on its declared algorithm,
 * restricted to algorithms we accept. Returns null if the token's alg is not
 * accepted (caller should reject). Never uses the public key as an HMAC secret.
 */
function getVerifyParamsForToken(token) {
  let alg;
  try {
    alg = jwt.decode(token, { complete: true })?.header?.alg;
  } catch {
    alg = undefined;
  }
  if (alg === "RS256" && PUBLIC_KEY) {
    return { key: PUBLIC_KEY, algorithms: ["RS256"] };
  }
  if (alg === "HS256" && ACCEPT_HS256 && JWT_SECRET) {
    return { key: JWT_SECRET, algorithms: ["HS256"] };
  }
  return null;
}

/**
 * Algorithm-aware jwt.verify for callers that intentionally verify OUTSIDE the
 * secret-worker (e.g. the guest refresh-proof check), i.e. without the worker's
 * revocation/jti checks. Our algorithm list always wins over caller options to
 * preserve the alg-confusion guarantee. Throws on failure.
 */
function verifyLocal(token, options = {}) {
  const params = getVerifyParamsForToken(token);
  if (!params) throw new Error("Unsupported or unaccepted token algorithm");
  const decoded = jwt.verify(token, params.key, { ...options, algorithms: params.algorithms });
  // P3-5: apply the same iss/aud policy as the worker (monitor logs, enforce
  // rejects). Runs only for tokens our keys verified.
  enforceClaims(decoded, "verifyLocal");
  return decoded;
}

/** Human-readable posture for startup logging. */
function describe() {
  const accepted = [];
  if (PUBLIC_KEY) accepted.push("RS256");
  if (ACCEPT_HS256 && JWT_SECRET) accepted.push("HS256");
  return {
    signAlg: JWT_ALG,
    accepted,
    hasPrivateKey: !!PRIVATE_KEY,
    hasPublicKey: !!PUBLIC_KEY,
    acceptHs256: ACCEPT_HS256,
    issuer: JWT_ISSUER,
    audiences: AUDIENCES,
    verifyClaimsMode: VERIFY_CLAIMS_MODE,
  };
}

module.exports = {
  JWT_ALG,
  ACCEPT_HS256,
  JWT_ISSUER,
  AUDIENCES,
  VERIFY_CLAIMS_MODE,
  getSigningParams,
  getVerifyParamsForToken,
  verifyLocal,
  audienceForRole,
  audienceMatches,
  checkClaims,
  enforceClaims,
  getClaimsPolicy,
  describe,
};
