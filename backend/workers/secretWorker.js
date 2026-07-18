// backend/workers/secretWorker.js

const { parentPort, workerData } = require("worker_threads");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

// P2-3: hydrate the JWT key/alg vars from workerData (so they're available even
// if process.env isn't inherited) BEFORE loading the key-policy module, which
// reads them from process.env at require time.
if (workerData && typeof workerData === "object") {
  for (const k of [
    "JWT_SECRET",
    "JWT_PRIVATE_KEY",
    "JWT_PUBLIC_KEY",
    "JWT_ALG",
    "JWT_ACCEPT_HS256",
    // P3-5: issuer/audience claim policy (read by jwtKeys at require time below)
    "JWT_ISSUER",
    "JWT_AUDIENCE",
    "JWT_AUD_GUEST",
    "JWT_AUD_ADMIN",
    "JWT_AUD_SUPERADMIN",
    "JWT_VERIFY_CLAIMS",
  ]) {
    if (workerData[k] != null && process.env[k] == null) {
      process.env[k] = workerData[k];
    }
  }
}
const jwtKeys = require("../utils/jwtKeys");

// ─────────────────────────────────────────────────────────────────────────────
// Config (keep in sync with server.js / edge)
// ─────────────────────────────────────────────────────────────────────────────
const CLOCK_SKEW_SECONDS = Number(process.env.JWT_CLOCK_SKEW_SEC || "60"); // skew tolerance
const REDIS_PREFIX = process.env.JWT_REDIS_PREFIX || "jwt:revoked:";
// P2-4: do NOT log secret material. The previous lines logged a JWT_SECRET
// prefix and dumped the full workerData object — which after P2-3 also carries
// the RSA PRIVATE key. The active alg/key posture is reported (without any key
// bytes) by the jwtKeys.describe() log below.

// In-memory fallback store for revoked JTIs
const revokedInMemory = new Set();

// Optional Redis (only used if REDIS_URL is configured)
const { getRedis, ensureRedisConnected } = require("../utils/redis");
let useRedis = !!process.env.REDIS_URL;

// P2-1: when Redis is the configured revocation backend but a check is UNKNOWN
// (store unreachable), the in-memory fallback can MISS revocations made on
// other instances or before a restart — a force-logged-out token would then be
// accepted. Operators can opt into fail-closed (reject the token) for the
// strongest session security, at the cost of availability during a Redis
// outage. Default: fail-open (legacy behavior, no lockout risk).
const REVOCATION_FAIL_CLOSED =
  String(process.env.JWT_REVOCATION_FAIL_CLOSED || "").toLowerCase() === "true";

// Eager posture log (P2-3): reflect the active signing algorithm + the set of
// accepted verification algorithms so the JWT key model is obvious in logs.
{
  const d = jwtKeys.describe();
  console.log(
    `[secretWorker] JWT sign=${d.signAlg}; verify accepts=[${d.accepted.join(", ") || "none"}]` +
      `; privateKey=${d.hasPrivateKey ? "yes" : "no"}, publicKey=${d.hasPublicKey ? "yes" : "no"}` +
      `; iss=${d.issuer}; claims=${d.verifyClaimsMode}`
  );
  if (d.signAlg === "RS256" && !d.hasPrivateKey) {
    console.error(
      "[secretWorker] ❌ JWT_ALG=RS256 but JWT_PRIVATE_KEY missing — signing will fail."
    );
  }
  if (d.accepted.length === 0) {
    console.warn(
      "[secretWorker] ⚠️ No verification keys configured — token verify will fail."
    );
  }
}

if (useRedis) {
  (async () => {
    try {
      const client = getRedis();
      await ensureRedisConnected(client);
      console.log("[secretWorker] ✅ Connected to Redis for JWT revocation");
    } catch (err) {
      useRedis = false;
      console.error(
        "[secretWorker] ⚠️ Redis connection failed, using in-memory store",
        err.message
      );
    }
  })();
} else {
  console.log("[secretWorker] ⚠️ No REDIS_URL configured, using in-memory store");
}
console.log(
  `[secretWorker] Revocation mode: ${useRedis ? "redis" : "in-memory"}, fail-${
    REVOCATION_FAIL_CLOSED ? "closed" : "open"
  }`
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: Redis-backed revoke / check
// ─────────────────────────────────────────────────────────────────────────────
async function revokeJtiRedis(jti, expTsSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  let ttlSeconds = Math.ceil((Number(expTsSec) || 0) - nowSec);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = 1;

  const client = getRedis();
  try {
    await ensureRedisConnected(client);
    await client.set(`${REDIS_PREFIX}${jti}`, "1", "EX", ttlSeconds);
    return true;
  } catch (e) {
    console.error("[secretWorker] Redis revoke failed, falling back to memory:", e.message);
    return false;
  }
}

async function isJtiRevokedRedis(jti) {
  const client = getRedis();
  try {
    await ensureRedisConnected(client);
    const val = await client.get(`${REDIS_PREFIX}${jti}`);
    return val === "1";
  } catch (e) {
    console.error("[secretWorker] Redis check failed, using memory fallback:", e.message);
    return null; // signal "unknown"
  }
}

function revokeJtiMemory(jti, expTsSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  let ttlSeconds = Math.ceil((Number(expTsSec) || 0) - nowSec);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = 1;
  revokedInMemory.add(jti);
  setTimeout(() => revokedInMemory.delete(jti), ttlSeconds * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker message handler
// Actions: sign | verify | revoke
// ─────────────────────────────────────────────────────────────────────────────
parentPort.on("message", async (task) => {
  try {
    let result;

    switch (task.action) {
      // ─────────────────────────────────────────────────────────────────────
      // SIGN
      // ─────────────────────────────────────────────────────────────────────
      case "sign": {
        if (!task.data.jti) task.data.jti = uuidv4();

        // P2-3: signing key + algorithm come from the central key policy
        // (RS256 private key when JWT_ALG=RS256, else the HS256 secret).
        const { key: signingKey, algorithm: signingAlg } = jwtKeys.getSigningParams();

        // sanitize caller options
        const raw = task.options && typeof task.options === "object" ? task.options : {};
        const signOpts = { algorithm: signingAlg };

        // allow-list and validate each option type
        if (raw.expiresIn != null) signOpts.expiresIn = raw.expiresIn;
        if (typeof raw.issuer === "string") signOpts.issuer = raw.issuer;
        if (typeof raw.subject === "string") signOpts.subject = raw.subject;
        if (typeof raw.notBefore === "string") signOpts.notBefore = raw.notBefore;
        if (typeof raw.keyid === "string") signOpts.keyid = raw.keyid;
        if (typeof raw.jwtid === "string") signOpts.jwtid = raw.jwtid;
        if (typeof raw.mutatePayload === "boolean") signOpts.mutatePayload = raw.mutatePayload;

        // handle "audience" safely
        if (
          typeof raw.audience === "string" ||
          (Array.isArray(raw.audience) && raw.audience.every((x) => typeof x === "string"))
        ) {
          signOpts.audience = raw.audience;
        }

        if (raw.header && typeof raw.header === "object") signOpts.header = raw.header;

        // Default TTL fallback if expiresIn not provided
        if (!signOpts.expiresIn) {
          const ttlMin = Number(process.env.JWT_TTL_MIN || "30");
          signOpts.expiresIn = `${ttlMin}m`;
        }

        // P3-5: bind the token to a known issuer + a role-specific audience so it
        // can't be replayed across roles/services. Any caller-supplied issuer/
        // audience wins; otherwise we default iss from policy and derive aud from
        // the payload's role. (jwt.sign would throw if task.data already carried
        // iss/aud — our payloads never do.)
        const claimsPolicy = jwtKeys.getClaimsPolicy();
        if (signOpts.issuer == null && claimsPolicy.issuer) {
          signOpts.issuer = claimsPolicy.issuer;
        }
        if (signOpts.audience == null) {
          const aud = claimsPolicy.audienceForRole(task.data && task.data.role);
          if (aud) signOpts.audience = aud;
        }

        result = jwt.sign(task.data, signingKey, signOpts);
        parentPort.postMessage({ id: task.id, result });
        break;
      }

      // ─────────────────────────────────────────────────────────────────────
      // VERIFY
      // ─────────────────────────────────────────────────────────────────────
      case "verify": {
        // P2-3: pick the verification key from the token's declared algorithm,
        // restricted to algorithms we accept (RS256 via public key, HS256 via
        // secret). Never verifies an RS256 token with an HMAC secret or vice
        // versa (alg-confusion safe).
        const vparams = jwtKeys.getVerifyParamsForToken(task.token);
        if (!vparams) {
          // TST5: undecodable tokens / unaccepted algs are hostile INPUT, not a
          // server fault — same class as jwt.verify's own "jwt malformed" /
          // "invalid algorithm", so carry the standard name for the 401 mapping.
          const e = new Error("UnsupportedAlgorithm");
          e.name = "JsonWebTokenError";
          throw e;
        }

        const raw = task.options && typeof task.options === "object" ? task.options : {};
        const verifyOpts = {
          clockTolerance: CLOCK_SKEW_SECONDS,
        };

        if (raw.ignoreExpiration === true) verifyOpts.ignoreExpiration = true;
        if (typeof raw.subject === "string") verifyOpts.subject = raw.subject;
        // P3-5: iss/aud are NOT passed to jwt.verify here. They're applied by the
        // central claim policy below (jwtKeys.enforceClaims) so we can run a
        // monitor mode (log-only) before enforcing, and key the expected audience
        // off the token's own role rather than a per-caller option.
        if (typeof raw.maxAge === "string") verifyOpts.maxAge = raw.maxAge;
        if (Number.isFinite(raw.clockTimestamp)) verifyOpts.clockTimestamp = raw.clockTimestamp;

        result = jwt.verify(task.token, vparams.key, {
          ...verifyOpts,
          algorithms: vparams.algorithms,
        });

        if (!result.jti) throw new Error("MissingJTI");

        // P3-5: issuer/audience policy (monitor logs, enforce rejects). Only runs
        // for tokens our keys verified — Firebase ID tokens never reach here
        // (they fail our signature check and fall back to verifyIdToken upstream).
        jwtKeys.enforceClaims(result, "verify");

        // Check revocation (Redis preferred)
        if (useRedis) {
          const redisRevoked = await isJtiRevokedRedis(result.jti);
          if (redisRevoked === true) throw new Error("TokenRevoked");
          if (redisRevoked === null) {
            // Revocation store unreachable: in-memory may be incomplete across
            // instances/restarts (P2-1). Fail-closed rejects to be safe.
            if (REVOCATION_FAIL_CLOSED) {
              console.warn(
                `[secretWorker] \ud83d\udd12 FAIL-CLOSED: revocation store unavailable \u2014 rejecting jti=${result.jti}`
              );
              throw new Error("TokenRevoked");
            }
            if (revokedInMemory.has(result.jti)) throw new Error("TokenRevoked");
          }
        } else {
          if (revokedInMemory.has(result.jti)) throw new Error("TokenRevoked");
        }

        parentPort.postMessage({ id: task.id, result });
        break;
      }

      // ─────────────────────────────────────────────────────────────────────
      // REVOKE
      // ─────────────────────────────────────────────────────────────────────
      case "revoke": {
        const { jti, expTimestamp } = task.data || {};
        if (!jti || !Number.isFinite(Number(expTimestamp))) {
          throw new Error("InvalidRevokeArgs");
        }

        let revokedOk = false;
        if (useRedis) revokedOk = await revokeJtiRedis(jti, Number(expTimestamp));
        if (!revokedOk) revokeJtiMemory(jti, Number(expTimestamp));

        parentPort.postMessage({ id: task.id, result: true });
        break;
      }

      default:
        throw new Error(`Unknown action ${task.action}`);
    }
  } catch (err) {
    // TST5: send name/code too — jsonwebtoken's error NAMES (TokenExpiredError,
    // JsonWebTokenError) are what middlewares map to clean 401s; flattening to
    // a bare message made expired/garbage tokens surface as 500s.
    parentPort.postMessage({
      id: task.id,
      error: { message: err.message, name: err.name, code: err.code },
    });
  }
});
