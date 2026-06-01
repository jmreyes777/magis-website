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

let worker = null;
const callbacks = new Map();
let counter = 0;

function getWorker() {
  if (!worker) {
    worker = spawnWorker();
  }
  return worker;
}

function spawnWorker() {
  const jwtSecret = process.env.JWT_SECRET || "fallback-jwt-secret-key-for-testing-only-32chars!";
  console.log("[secretPool] Spawning worker, JWT_SECRET length:", jwtSecret.length);
  const w = new Worker(path.resolve(__dirname, "../workers/secretWorker.js"), {
    workerData: { JWT_SECRET: jwtSecret },
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
    for (const [id, entry] of callbacks.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
      callbacks.delete(id);
    }
    console.error("[secretPool] Worker error:", err);
  });

  w.on("exit", (code) => {
    for (const [id, entry] of callbacks.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`secretWorker exited with code ${code}`));
      callbacks.delete(id);
    }
    if (code !== 0) {
      console.error(`[secretPool] Worker exited unexpectedly (code ${code}). Will respawn on next use.`);
      worker = null;
    }
  });

  return w;
}

function callWorker(action, payload, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // sanitize options to avoid non-object errors
  const safeOptions = options && typeof options === "object" ? options : {};

  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`secretWorker ${action} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    callbacks.set(id, { resolve, reject, timer });
    getWorker().postMessage({ id, action, ...payload, options: safeOptions });
  });
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

  revokeJWT: ({ jti, expTimestamp }) =>
    callWorker("revoke", { data: { jti, expTimestamp } }),

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
    try {
      await worker.terminate();
    } catch (e) {
      console.error("[secretPool] Error during worker termination:", e);
    }
  },

  _defaults: {
    CLOCK_TOLERANCE_SEC,
    DEFAULT_GUEST_TTL_MIN,
    DEFAULT_ADMIN_TTL_MIN,
    DEFAULT_TIMEOUT_MS,
  },
};
