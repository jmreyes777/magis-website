// backend/perf/dos-backpressure.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SEC26 Wave 4 — DoS / backpressure proof (zero-dependency, like baseline.mjs;
// Artillery was deliberately NOT added: a load tool with hundreds of transitive
// deps inside the security-audited tree would undercut Wave 3).
//
// The 2026 research's DoS pillar (PQC handshake exhaustion) maps to this
// origin's analogous hot path: worker-pool JWT verification. This driver
// proves three properties under flood:
//
//   1. BACKPRESSURE — when the secretPool saturates, requests get a clean,
//      bounded 503 (EWORKERBUSY contract), never a hang or a crash.
//   2. LIMITS — hot-read buckets (SEC26 W0) 429 once an identity's budget is
//      spent; auth floods with garbage tokens burn 401 cheaply.
//   3. LIVENESS — /health p95 stays sane WHILE the flood runs (the event loop
//      is not starved; other tenants still get service).
//
// Usage (NEVER against production):
//   node perf/dos-backpressure.mjs                     # local default :8787
//   BASE_URL=https://staging... GUEST_TOKEN=<jwt> node perf/dos-backpressure.mjs
//   FLOOD_N=2000 FLOOD_CONCURRENCY=200 node perf/dos-backpressure.mjs
//
// Exit code 0 = all properties held; 1 = a property failed (prints which).
// SECURITY: tokens come from env only, are never logged, never persisted.
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const FLOOD_N = Number(process.env.FLOOD_N || 1000);
const FLOOD_CONCURRENCY = Number(process.env.FLOOD_CONCURRENCY || 100);
const GUEST_TOKEN = process.env.GUEST_TOKEN || "";
const HEALTH_P95_BUDGET_MS = Number(process.env.HEALTH_P95_BUDGET_MS || 500);

const lib = BASE_URL.startsWith("https") ? https : http;

function once(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = lib.request(BASE_URL + path, { method, headers, agent: false }, (res) => {
      res.resume(); // drain; we only need status + timing
      res.on("end", () =>
        resolve({ status: res.statusCode, ms: performance.now() - t0 })
      );
    });
    req.on("error", () => resolve({ status: 0, ms: performance.now() - t0 }));
    if (body) req.write(body);
    req.end();
  });
}

async function pool(n, concurrency, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      results.push(await fn(i));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return results;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function summarize(name, results) {
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const line = {
    probe: name,
    n: results.length,
    p50_ms: Math.round(pct(times, 50)),
    p95_ms: Math.round(pct(times, 95)),
    p99_ms: Math.round(pct(times, 99)),
    statuses: byStatus,
  };
  console.log(JSON.stringify(line));
  return { byStatus, times };
}

async function main() {
  console.log(`# DoS/backpressure probe → ${BASE_URL} (flood=${FLOOD_N} @ ${FLOOD_CONCURRENCY})`);
  const failures = [];

  // ── Probe 1: JWT-verification flood (garbage bearer tokens) ───────────────
  // Every request forces a full signature verification in the worker pool —
  // the origin's most expensive per-request crypto. Acceptable outcomes per
  // request: 401 (verified & rejected), 403 (edge/CSRF), 429 (limited),
  // 503 (EWORKERBUSY backpressure). NOT acceptable: 0 (socket death), 5xx
  // other than 503, or hangs (implicit: the pool would never drain).
  const garbage = "Bearer eyJhbGciOiJIUzI1NiJ9." + "A".repeat(64) + ".B".repeat(43);
  const health1 = [];
  const healthSampler = setInterval(async () => {
    health1.push(await once("/health"));
  }, 100);

  const flood = await pool(FLOOD_N, FLOOD_CONCURRENCY, () =>
    once("/api/messages/media/dos-probe", { headers: { Authorization: garbage } })
  );
  clearInterval(healthSampler);

  const { byStatus } = summarize("jwt-verify-flood", flood);
  const badStatuses = Object.keys(byStatus)
    .map(Number)
    .filter((s) => s === 0 || (s >= 500 && s !== 503));
  if (badStatuses.length) {
    failures.push(`flood produced non-contract statuses: ${badStatuses.join(",")}`);
  }

  // ── Probe 2: liveness under flood ──────────────────────────────────────────
  if (health1.length) {
    const { times } = summarize("health-during-flood", health1);
    const p95 = pct(times, 95);
    const dead = health1.filter((r) => r.status !== 200).length;
    if (p95 > HEALTH_P95_BUDGET_MS) {
      failures.push(`/health p95 ${Math.round(p95)}ms > ${HEALTH_P95_BUDGET_MS}ms during flood (event-loop starvation)`);
    }
    if (dead > 0) failures.push(`/health failed ${dead}x during flood`);
  }

  // ── Probe 3 (opt-in): hot-read budget with a REAL guest token ─────────────
  // Proves the SEC26 W0 limiter 429s a single hostile identity. Requires
  // GUEST_TOKEN; skipped otherwise (the harness never fabricates auth).
  if (GUEST_TOKEN) {
    const burst = await pool(400, 50, () =>
      once("/api/messages/media/dos-probe", { headers: { Authorization: `Bearer ${GUEST_TOKEN}` } })
    );
    const { byStatus: hot } = summarize("hot-read-burst(authed)", burst);
    if (!hot[429]) failures.push("authed hot-read burst never hit 429 — limiter inert?");
  } else {
    console.log('{"probe":"hot-read-burst(authed)","skipped":"set GUEST_TOKEN to run"}');
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("\nPASS: backpressure bounded (503-only overflow), liveness held, limits enforced where testable.");
}

main();
