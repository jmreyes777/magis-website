/**
 * utils/redis.js
 * --------------------------------------------------------
 * Centralized Redis connection manager for the Magis backend.
 * Provides:
 *  - getRedis():   General-purpose client (commands, key-value, revocations)
 *  - getRedisSub(): Secondary client (for Socket.IO adapter pub/sub)
 *  - ensureRedisConnected(client): idempotent connect guard for ioredis
 *  - closeRedis(): graceful shutdown
 *
 * Uses ioredis for robust reconnects and lazy connections.
 * --------------------------------------------------------
 */

const Redis = require("ioredis");

let client;     // main command connection
let subClient;  // subscriber connection (used by Socket.IO adapter)

// Resolve the best Redis URL at startup:
// 1. Explicit REDIS_URL env var (always wins)
// 2. redis://[::1]:6379  — native Windows Redis (listens on IPv6 loopback)
// 3. redis://127.0.0.1:6379 — fallback for Linux/WSL/Docker
function resolveRedisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  return "redis://[::1]:6379";
}

/**
 * Whether a Redis backend has been EXPLICITLY configured via REDIS_URL.
 * The localhost default above keeps dev working, but in production an unset
 * REDIS_URL silently points at a non-existent localhost instance — which is how
 * rate-limiting and JWT revocation end up inert (P2-1). server.js uses this to
 * surface the degradation loudly (and optionally hard-fail) at startup.
 */
function isRedisConfigured() {
  return !!process.env.REDIS_URL;
}

// Track a single in-flight connect() per client to avoid races
const connectPromises = new WeakMap();

// Create base options shared by all clients
function getBaseOptions() {
  return {
    lazyConnect: true,           // connect only when first needed
    maxRetriesPerRequest: 2,     // prevent hanging if Redis is down
    enableAutoPipelining: true,  // optimize command throughput
    // Optional: tune retry strategy here if desired
    reconnectOnError: (err) => {
      // simple reconnect strategy for common transient errors
      const msg = String(err?.message || "");
      const target = ["READONLY", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"];
      if (target.some(code => msg.includes(code))) {
        console.warn("[redis] Reconnecting after error:", msg);
        return true;
      }
      return false;
    },
  };
}

/**
 * Returns a shared Redis client for general commands.
 * The connection is established lazily when first used.
 */
function getRedis() {
  if (!client) {
    const url = resolveRedisUrl();
    client = new Redis(url, getBaseOptions());

    // Logging for visibility
    client.on("connect", () => console.log("[redis] Connected:", url));
    client.on("ready",   () => console.log("[redis] Ready"));
    client.on("error",   (err) => console.error("[redis] Error:", err.message));
    client.on("close",   () => console.warn("[redis] Connection closed"));
    client.on("end",     () => console.warn("[redis] Connection ended"));
    client.on("reconnecting", () => console.warn("[redis] Reconnecting..."));
  }
  return client;
}

/**
 * Returns a separate Redis client for pub/sub operations.
 * This is required by the Socket.IO Redis adapter.
 */
function getRedisSub() {
  if (!subClient) {
    const url = resolveRedisUrl();
    subClient = new Redis(url, getBaseOptions());

    subClient.on("connect", () => console.log("[redis:sub] Connected:", url));
    subClient.on("ready",   () => console.log("[redis:sub] Ready"));
    subClient.on("error",   (err) => console.error("[redis:sub] Error:", err.message));
    subClient.on("close",   () => console.warn("[redis:sub] Connection closed"));
    subClient.on("end",     () => console.warn("[redis:sub] Connection ended"));
    subClient.on("reconnecting", () => console.warn("[redis:sub] Reconnecting..."));
  }
  return subClient;
}

/**
 * Idempotent connect guard for **ioredis**.
 * - If status is 'ready' → returns immediately.
 * - If status is 'connecting' → awaits the same in-flight promise.
 * - If status is 'wait' (lazy) or 'end' → calls connect() once and caches the promise.
 */
async function ensureRedisConnected(redisClient) {
  if (!redisClient) throw new Error("ensureRedisConnected: client is undefined/null");

  // ioredis statuses: 'wait' | 'connecting' | 'ready' | 'end' | 'reconnecting'
  const status = redisClient.status;

  if (status === "ready") return redisClient;

  // If we already have a connect promise for this client, reuse it.
  const existing = connectPromises.get(redisClient);
  if (existing) {
    await existing;
    return redisClient;
  }

  // Create and cache a single connect promise
  const p = (async () => {
    // Avoid double-connect calls if status flips to connecting between lines
    if (redisClient.status === "ready") return;
    if (redisClient.status === "connecting") return; // let ioredis finish its own connect
    try {
      await redisClient.connect(); // only valid with lazyConnect:true
    } finally {
      // Always clear the promise reference so a future reconnect can set a new one
      connectPromises.delete(redisClient);
    }
  })();

  connectPromises.set(redisClient, p);
  await p;
  return redisClient;
}

/**
 * Gracefully close Redis connections on shutdown (optional but recommended)
 */
async function closeRedis() {
  try {
    if (client) {
      await client.quit();
      console.log("[redis] Client closed");
      client = null;
    }
    if (subClient) {
      await subClient.quit();
      console.log("[redis:sub] Client closed");
      subClient = null;
    }
  } catch (err) {
    console.error("[redis] Error closing connections:", err.message);
  }
}

module.exports = {
  getRedis,
  getRedisSub,
  ensureRedisConnected,
  closeRedis,
  isRedisConfigured,
};
