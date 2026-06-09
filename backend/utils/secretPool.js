// backend/utils/secretPool.js
const { Worker } = require("worker_threads");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Aligned defaults (match server.js / secretWorker.js)
// ─────────────────────────────────────────────────────────────────────────────
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "60");
const DEFAULT_GUEST_TTL_MIN = Number(process.env.JWT_TTL_MIN || "30");
const DEFAULT_ADMIN_TTL_MIN = Number(process.env.JWT_ADMIN_TTL_MIN || "240");
const DEFAULT_TIMEOUT_MS = Number(process.env.JWT_WORKER_TIMEOUT_MS || "10000");

// PERF3-1: round-robin pool of identical secret workers. The signing secret
// still lives ONLY inside worker threads (never on the main thread), and every
// worker runs the EXACT same sign/verify/revoke logic — this is a pure
// throughput change. `sign`/`verify` are dispatched round-robin; `revoke` is
// BROADCAST to every worker (see broadcastToPool) so each worker's in-memory
// revocation fallback — used only when Redis is unreachable — stays consistent
// across the pool, preserving the single-worker revocation semantics exactly.
const POOL_SIZE = Math.max(parseInt(process.env.JWT_WORKER_POOL, 10) || 4, 1);

const workers = new Array(POOL_SIZE).fill(null);
const callbacks = new Map();
let counter = 0;
let rr = 0;

function spawnWorker(index) {
  // P2-4: no hardcoded fallback secret. If JWT_SECRET is required (HS256 mode)
  // but missing, the worker's key policy fails loudly rather than silently
  // signing with a publicly-known constant. Never log the secret/length.
  const jwtSecret = process.env.JWT_SECRET;
  console.log(`[secretPool] Spawning secret worker ${index + 1}/${POOL_SIZE}`);
  const w = new Worker(path.resolve(__dirname, "../workers/secretWorker.js"), {
    // P2-3: forward the asymmetric key material + alg policy too. Undefined
    // values are skipped by the worker's hydration guard, so this is a no-op
    // until the operator provisions RS256 keys.
    workerData: {
      JWT_SECRET: jwtSecret,
      JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY,
      JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY,
      JWT_ALG: process.env.JWT_ALG,
      JWT_ACCEPT_HS256: process.env.JWT_ACCEPT_HS256,
      // P3-5: issuer/audience claim policy (read by jwtKeys inside the worker)
      JWT_ISSUER: process.env.JWT_ISSUER,
      JWT_AUDIENCE: process.env.JWT_AUDIENCE,
      JWT_AUD_GUEST: process.env.JWT_AUD_GUEST,
      JWT_AUD_ADMIN: process.env.JWT_AUD_ADMIN,
      JWT_AUD_SUPERADMIN: process.env.JWT_AUD_SUPERADMIN,
      JWT_VERIFY_CLAIMS: process.env.JWT_VERIFY_CLAIMS,
    },
  });

  w.on("message", ({ id, result, error }) => {
    const entry = callbacks.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    callbacks.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  });

  w.on("error", (err) => {
    rejectWorkerCallbacks(index, err);
    console.error(`[secretPool] Worker ${index} error:`, err);
  });

  w.on("exit", (code) => {
    rejectWorkerCallbacks(index, new Error(`secretWorker ${index} exited with code ${code}`));
    if (code !== 0) {
      console.error(`[secretPool] Worker ${index} exited unexpectedly (code ${code}). Will respawn on next use.`);
    }
    // Free the slot so the next dispatch lazily respawns a replacement.
    workers[index] = null;
  });

  workers[index] = w;
  return w;
}

function getWorker(index) {
  if (!workers[index]) spawnWorker(index);
  return workers[index];
}

// Round-robin selection for the parallelizable sign/verify hot path.
function pickWorker() {
  const index = rr;
  rr = (rr + 1) % POOL_SIZE;
  return { worker: getWorker(index), index };
}

// Reject only the in-flight callbacks owned by the worker that errored/exited,
// leaving the rest of the pool's pending calls untouched.
function rejectWorkerCallbacks(workerIndex, err) {
  for (const [id, entry] of callbacks.entries()) {
    if (entry.workerIndex !== workerIndex) continue;
    clearTimeout(entry.timer);
    callbacks.delete(id);
    entry.reject(err);
  }
}

function callWorker(action, payload, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // sanitize options to avoid non-object errors
  const safeOptions = options && typeof options === "object" ? options : {};

  return new Promise((resolve, reject) => {
    const id = ++counter;
    const { worker, index } = pickWorker();
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`secretWorker ${action} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    callbacks.set(id, { resolve, reject, timer, workerIndex: index });
    worker.postMessage({ id, action, ...payload, options: safeOptions });
  });
}

// Dispatch the SAME task to every worker and resolve once all have completed.
// Used for `revoke` so each worker records the revocation in its own in-memory
// fallback set — keeping revocation effective even if Redis is unreachable and
// a subsequent verify is routed to a different worker. Revokes are rare, so the
// extra fan-out (and idempotent per-worker Redis SET) is negligible.
function broadcastToPool(action, payload, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const safeOptions = options && typeof options === "object" ? options : {};
  const calls = [];
  for (let index = 0; index < POOL_SIZE; index++) {
    const worker = getWorker(index);
    calls.push(
      new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => {
          callbacks.delete(id);
          reject(new Error(`secretWorker ${action} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        callbacks.set(id, { resolve, reject, timer, workerIndex: index });
        worker.postMessage({ id, action, ...payload, options: safeOptions });
      })
    );
  }
  return Promise.all(calls);
}

module.exports = {
  // ───────────────────────────────────────────────────────────────────────────
  // Core API
  // ───────────────────────────────────────────────────────────────────────────

  signJWT: (data, options) =>
    callWorker("sign", { data }, options && typeof options === "object" ? options : {}),

  verifyJWT: (token, options = {}) =>
    callWorker(
      "verify",
      { token },
      {
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
        ...(typeof options === "object" ? options : {}),
      }
    ),

  revokeJWT: async ({ jti, expTimestamp }) => {
    // Broadcast so EVERY worker records the revocation in its in-memory fallback
    // (Redis stays the shared source of truth when available). Preserves the
    // single-worker guarantee that a revoked jti is rejected by any later verify.
    await broadcastToPool("revoke", { data: { jti, expTimestamp } });
    return true;
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Convenience helpers (aligned with TTLs)
  // ───────────────────────────────────────────────────────────────────────────

  signGuestJWT(data, options = {}) {
    return callWorker("sign", { data }, { expiresIn: `${DEFAULT_GUEST_TTL_MIN}m`, ...options });
  },

  signAdminJWT(data, options = {}) {
    return callWorker("sign", { data }, { expiresIn: `${DEFAULT_ADMIN_TTL_MIN}m`, ...options });
  },

  async shutdown() {
    await Promise.all(
      workers.map(async (w, i) => {
        if (!w) return;
        try {
          await w.terminate();
        } catch (e) {
          console.error(`[secretPool] Error terminating worker ${i}:`, e);
        } finally {
          workers[i] = null;
        }
      })
    );
  },

  _defaults: {
    CLOCK_TOLERANCE_SEC,
    DEFAULT_GUEST_TTL_MIN,
    DEFAULT_ADMIN_TTL_MIN,
    DEFAULT_TIMEOUT_MS,
    POOL_SIZE,
  },
};
