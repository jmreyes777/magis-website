// backend/workers/secretWorker.js

const { parentPort, workerData } = require("worker_threads");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

// ─────────────────────────────────────────────────────────────────────────────
// Config (keep in sync with server.js / edge)
// ─────────────────────────────────────────────────────────────────────────────
const CLOCK_SKEW_SECONDS = Number(process.env.JWT_CLOCK_SKEW_SEC || "60"); // skew tolerance
const REDIS_PREFIX = process.env.JWT_REDIS_PREFIX || "jwt:revoked:";
const JWT_SECRET = workerData?.JWT_SECRET || process.env.JWT_SECRET;
console.log("[secretWorker] Received JWT_SECRET:", JWT_SECRET ? "SET (" + JWT_SECRET.substring(0, 10) + "...)" : "NOT SET");
console.log("[secretWorker] workerData:", workerData);

// In-memory fallback store for revoked JTIs
const revokedInMemory = new Set();

// Optional Redis (only used if REDIS_URL is configured)
const { getRedis, ensureRedisConnected } = require("../utils/redis");
let useRedis = !!process.env.REDIS_URL;

// Eager log (not a hard failure if missing)
if (!JWT_SECRET) {
  console.warn("[secretWorker] ⚠️ JWT_SECRET is not set. Token ops will fail.");
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
        if (!JWT_SECRET) throw new Error("MissingJWTSecret");

        if (!task.data.jti) task.data.jti = uuidv4();

        // sanitize caller options
        const raw = task.options && typeof task.options === "object" ? task.options : {};
        const signOpts = { algorithm: "HS256" };

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

        result = jwt.sign(task.data, JWT_SECRET, signOpts);
        parentPort.postMessage({ id: task.id, result });
        break;
      }

      // ─────────────────────────────────────────────────────────────────────
      // VERIFY
      // ─────────────────────────────────────────────────────────────────────
      case "verify": {
        if (!JWT_SECRET) throw new Error("MissingJWTSecret");

        const raw = task.options && typeof task.options === "object" ? task.options : {};
        const verifyOpts = {
          algorithms: ["HS256"],
          clockTolerance: CLOCK_SKEW_SECONDS,
        };

        if (raw.ignoreExpiration === true) verifyOpts.ignoreExpiration = true;
        if (typeof raw.issuer === "string") verifyOpts.issuer = raw.issuer;
        if (typeof raw.subject === "string") verifyOpts.subject = raw.subject;
        if (
          typeof raw.audience === "string" ||
          (Array.isArray(raw.audience) && raw.audience.every((x) => typeof x === "string"))
        ) {
          verifyOpts.audience = raw.audience;
        }
        if (typeof raw.maxAge === "string") verifyOpts.maxAge = raw.maxAge;
        if (Number.isFinite(raw.clockTimestamp)) verifyOpts.clockTimestamp = raw.clockTimestamp;

        result = jwt.verify(task.token, JWT_SECRET, verifyOpts);

        if (!result.jti) throw new Error("MissingJTI");

        // Check revocation (Redis preferred)
        if (useRedis) {
          const redisRevoked = await isJtiRevokedRedis(result.jti);
          if (redisRevoked === true) throw new Error("TokenRevoked");
          if (redisRevoked === null && revokedInMemory.has(result.jti)) {
            throw new Error("TokenRevoked");
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
    parentPort.postMessage({ id: task.id, error: err.message });
  }
});
