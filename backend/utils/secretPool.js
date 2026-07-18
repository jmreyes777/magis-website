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

// Item 3 (crash back-off): an ISOLATED worker crash still respawns immediately on
// next use (unchanged). Only REPEATED rapid crashes on the SAME slot (>= MAX within
// a rolling window) trigger a cooldown, during which the round-robin SKIPS that
// slot — bounding an attacker's ability to force a CPU-heavy crash/respawn loop
// without slowing one-off recovery. Revoke broadcasts deliberately bypass this.
const CRASH_WINDOW_MS = Number(process.env.JWT_WORKER_CRASH_WINDOW_MS || "10000");
const CRASH_MAX_IN_WINDOW = Math.max(parseInt(process.env.JWT_WORKER_CRASH_MAX, 10) || 2, 2);
const CRASH_BACKOFF_MS = Number(process.env.JWT_WORKER_BACKOFF_MS || "5000");

// Item 4 (backpressure): hard cap on in-flight callbacks so a verify flood can't
// grow the map without bound (OOM). Sized FAR above any legitimate concurrency
// (in-flight ~= request-rate x worker-latency, typically tens), so it never trips
// in normal/bursty use — only under an OOM-level flood, where callWorker rejects
// with a distinct `EWORKERBUSY` error that callers map to HTTP 503 (not 401).
const MAX_QUEUE = Math.max(parseInt(process.env.JWT_WORKER_MAX_QUEUE, 10) || 10000, POOL_SIZE * 16);

const workers = new Array(POOL_SIZE).fill(null);
const cooldownUntil = new Array(POOL_SIZE).fill(0); // ms epoch a cooling slot is skippable until
const recentCrashes = Array.from({ length: POOL_SIZE }, () => []); // rolling abnormal-exit timestamps
let shuttingDown = false; // suppress cooldown bookkeeping during graceful shutdown
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
    if (error) {
      // TST5: rebuild the error with its original identity. jsonwebtoken error
      // NAMES drive middleware status mapping (expired/malformed → 401, not 500).
      const e = new Error(typeof error === "string" ? error : error.message);
      if (error && typeof error === "object") {
        if (error.name && error.name !== "Error") e.name = error.name;
        if (error.code) e.code = error.code;
      }
      entry.reject(e);
    } else entry.resolve(result);
  });

  w.on("error", (err) => {
    rejectWorkerCallbacks(index, err);
    console.error(`[secretPool] Worker ${index} error:`, err);
  });

  w.on("exit", (code) => {
    rejectWorkerCallbacks(index, new Error(`secretWorker ${index} exited with code ${code}`));
    // Free the slot so the next dispatch lazily respawns a replacement.
    workers[index] = null;
    if (code === 0 || shuttingDown) return; // graceful exit — respawn lazily, no backoff

    console.error(`[secretPool] Worker ${index} exited unexpectedly (code ${code}).`);
    // Item 3: throttle ONLY repeated rapid crashes. Keep just the timestamps within
    // the rolling window; an isolated crash leaves the slot immediately respawnable.
    const now = Date.now();
    const recent = recentCrashes[index].filter((t) => now - t < CRASH_WINDOW_MS);
    recent.push(now);
    recentCrashes[index] = recent;
    if (recent.length >= CRASH_MAX_IN_WINDOW) {
      cooldownUntil[index] = now + CRASH_BACKOFF_MS;
      console.error(
        `[secretPool] Worker ${index} crashed ${recent.length}x within ${CRASH_WINDOW_MS}ms — backing off ${CRASH_BACKOFF_MS}ms (round-robin will skip it).`
      );
    }
  });

  workers[index] = w;
  return w;
}

function getWorker(index) {
  if (!workers[index]) spawnWorker(index);
  return workers[index];
}

// Round-robin selection for the parallelizable sign/verify hot path. Item 3: skip
// any slot that is cooling down after repeated rapid crashes, so a single bad slot
// can't keep getting picked back into a crash/respawn loop. If EVERY slot is cooling
// (extreme), respawn the soonest-recovering one anyway — we never reject here, so the
// hot path always serves at least as many requests as before.
function pickWorker() {
  const now = Date.now();
  for (let n = 0; n < POOL_SIZE; n++) {
    const index = rr;
    rr = (rr + 1) % POOL_SIZE;
    if (workers[index] || cooldownUntil[index] <= now) {
      return { worker: getWorker(index), index };
    }
  }
  // All slots cooling: pick the one whose cooldown ends soonest and use it anyway.
  let best = 0;
  for (let i = 1; i < POOL_SIZE; i++) {
    if (cooldownUntil[i] < cooldownUntil[best]) best = i;
  }
  rr = (best + 1) % POOL_SIZE;
  return { worker: getWorker(best), index: best };
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
    // Item 4: backpressure. Shed load (instead of growing toward OOM) once the
    // in-flight map hits the high-watermark. Distinct `code` so callers return 503
    // (transient) rather than 401 (auth failure). Revoke broadcasts are exempt
    // (rare + security-critical) — see broadcastToPool.
    if (callbacks.size >= MAX_QUEUE) {
      const busy = new Error("secretWorker pool saturated");
      busy.code = "EWORKERBUSY";
      return reject(busy);
    }

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

  // Public verifier. The secret worker is the real trust boundary: it derives the
  // verification algorithm from the token under the alg-confusion-safe key policy
  // (jwtKeys.getVerifyParamsForToken) and applies its OWN clock skew, so a caller's
  // `algorithms`/`clockTolerance` are already ignored there. As defense-in-depth we
  // additionally STRIP the two options that could WEAKEN verification —
  // `ignoreExpiration` and `clockTimestamp` — so no caller (now or in future) can
  // accept an expired/not-yet-valid token through this path. The few internal flows
  // that must read a recently-expired token use verifyAllowExpired() below.
  verifyJWT: (token, options = {}) => {
    const safe = options && typeof options === "object" ? { ...options } : {};
    delete safe.ignoreExpiration;
    delete safe.clockTimestamp;
    return callWorker("verify", { token }, safe);
  },

  // Sanctioned entry point for the few internal flows that legitimately operate on
  // a recently-expired token: logout (→ revoke its jti) and fallback-token rotation.
  // Identical to verifyJWT EXCEPT expiration is ignored — signature, alg-confusion
  // safety, revocation and claim checks in the worker all still apply, and the
  // resolved payload still carries jti/exp/role for the caller to act on. Keeping
  // this explicit and separate is what lets the public verifyJWT hard-strip
  // `ignoreExpiration`.
  verifyAllowExpired: (token) => callWorker("verify", { token }, { ignoreExpiration: true }),

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
    shuttingDown = true; // stop the exit handler from arming cooldowns mid-teardown
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
    MAX_QUEUE,
    CRASH_BACKOFF_MS,
    CRASH_WINDOW_MS,
    CRASH_MAX_IN_WINDOW,
  },
};
