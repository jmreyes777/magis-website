/**
 * utils/cache.js
 * --------------------------------------------------------
 * PERF2-1: a tiny Redis-backed read-through cache for NEAR-STATIC,
 * NON-SENSITIVE data (e.g. the branch metadata list), generalizing the
 * one-off in-memory pattern used by the Facebook endpoints.
 *
 * SECURITY (read before adding a new cache site):
 *  - Cache ONLY non-user-specific, non-sensitive values. The CALLER decides
 *    what to cache, so never wrap:
 *      • auth / lockout / credential state (e.g. the `branchAdmins` doc:
 *        password hash, failedAttempts, lockedUntil, MFA secrets),
 *      • JWT revocation state,
 *      • conversation / message content (sensitive, encrypted at rest),
 *      • anything scoped to a single user/session.
 *  - Key entries by branch/role scope so one tenant can never read another's
 *    cached value.
 *
 * RELIABILITY:
 *  - FAIL-OPEN. Any Redis error/outage/timeout falls through to the source
 *    `producer()` so a cache problem can never break OR stall a request. A
 *    short per-op timeout bounds the added latency when Redis is unhealthy
 *    (ioredis here uses lazyConnect + maxRetriesPerRequest, with no in-memory
 *    fallback — so we must guard every call).
 *  - A producer that throws still throws (callers keep their own try/catch).
 *  - `undefined` producer results are returned but NOT cached, letting a
 *    caller signal "don't cache this" (e.g. a not-found lookup).
 */

const { getRedis, ensureRedisConnected } = require("./redis");

const PREFIX = process.env.CACHE_PREFIX || "cache:";
const OP_TIMEOUT_MS = Number(process.env.CACHE_OP_TIMEOUT_MS || 200);
const DISABLED = String(process.env.CACHE_DISABLED || "").toLowerCase() === "true";

// Throttle noisy logs when Redis is unavailable (at most once per minute).
let lastLogAt = 0;
function warnThrottled(msg) {
  const now = Date.now();
  if (now - lastLogAt > 60_000) {
    lastLogAt = now;
    console.warn("[cache] (fail-open)", msg);
  }
}

// Bound any single cache operation so an unhealthy Redis cannot stall requests.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache ${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Build a namespaced cache key, e.g. key("branches","doc",id). */
function key(...parts) {
  return PREFIX + parts.filter((p) => p !== undefined && p !== null).join(":");
}

async function getJSON(k) {
  const client = getRedis();
  await withTimeout(ensureRedisConnected(client), OP_TIMEOUT_MS, "connect");
  const raw = await withTimeout(client.get(k), OP_TIMEOUT_MS, "get");
  if (raw == null) return undefined; // miss
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // poisoned/legacy value → treat as a miss
  }
}

async function setJSON(k, value, ttlSec) {
  const client = getRedis();
  await withTimeout(ensureRedisConnected(client), OP_TIMEOUT_MS, "connect");
  const ttl = Math.max(1, Math.floor(Number(ttlSec) || 0));
  await withTimeout(client.set(k, JSON.stringify(value), "EX", ttl), OP_TIMEOUT_MS, "set");
}

/**
 * Read-through cache.
 * Returns the cached value on a hit; otherwise calls `producer()`, stores the
 * result with `ttlSec`, and returns it. FAIL-OPEN on any cache error.
 *
 * @param {string} cacheKey   fully-qualified key (use `key(...)`)
 * @param {number} ttlSec     TTL in seconds (30–300 recommended)
 * @param {() => Promise<any>} producer source-of-truth loader
 */
async function cached(cacheKey, ttlSec, producer) {
  if (DISABLED) return producer();

  // 1) Attempt a cache read (never fatal).
  try {
    const hit = await getJSON(cacheKey);
    if (hit !== undefined) return hit;
  } catch (e) {
    warnThrottled(`read fell through: ${e.message}`);
  }

  // 2) Miss (or read failure) → load from source. A throw here propagates so
  //    the caller's existing error handling is preserved.
  const value = await producer();

  // 3) Best-effort write-back. Only cache defined values; never block on it.
  if (value !== undefined) {
    try {
      await setJSON(cacheKey, value, ttlSec);
    } catch (e) {
      warnThrottled(`write skipped: ${e.message}`);
    }
  }
  return value;
}

/**
 * Best-effort invalidation. Deletes one or more keys; swallows all errors so a
 * cache problem never fails a write request. Accepts strings and/or arrays.
 */
async function invalidate(...keys) {
  const flat = keys.flat().filter(Boolean);
  if (!flat.length || DISABLED) return;
  try {
    const client = getRedis();
    await withTimeout(ensureRedisConnected(client), OP_TIMEOUT_MS, "connect");
    await withTimeout(client.del(...flat), OP_TIMEOUT_MS, "del");
  } catch (e) {
    warnThrottled(`invalidate skipped: ${e.message}`);
  }
}

module.exports = { cached, invalidate, key };
