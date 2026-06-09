// backend/perf/baseline.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PERF0-1 — zero-dependency API latency baseline.
// Measures avg / p50 / p95 / p99 latency per endpoint using only Node built-ins,
// so it runs anywhere with no install step.
//
// Usage (run from the backend/ directory):
//   node perf/baseline.mjs
//   BASE_URL=https://magis-website.onrender.com N=200 CONCURRENCY=20 node perf/baseline.mjs
//
// Authenticated / parameterized endpoints are only exercised when you supply
// the relevant env vars (so the harness never guesses or fabricates auth):
//   ADMIN_TOKEN=<jwt>  MESSAGES_PATH=/api/messages?guestId=...&branchId=...
//   ADMIN_TOKEN=<jwt>  ANALYTICS_PATH=/api/analytics?start=...&end=...
//   GUEST_INIT_BODY='{"branchEmail":"..."}'   (POST /api/guest/init)
//
// SECURITY: read-only measurement. Tokens are read from the environment, never
// logged, and never written to disk. Point BASE_URL at a non-production target
// when load-testing, and never commit real tokens.
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const N = Number(process.env.N || 100);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GUEST_TOKEN = process.env.GUEST_TOKEN || "";

const authHeader = (t) => (t ? { authorization: `Bearer ${t}` } : {});

const endpoints = [
  { name: "GET /health", method: "GET", path: "/health" },

  ...(process.env.GUEST_INIT_BODY
    ? [{
        name: "POST /api/guest/init",
        method: "POST",
        path: "/api/guest/init",
        body: process.env.GUEST_INIT_BODY,
        headers: { "content-type": "application/json", ...authHeader(GUEST_TOKEN) },
      }]
    : []),

  ...(ADMIN_TOKEN && process.env.MESSAGES_PATH
    ? [{ name: "GET /api/messages", method: "GET", path: process.env.MESSAGES_PATH, headers: authHeader(ADMIN_TOKEN) }]
    : []),

  ...(ADMIN_TOKEN && process.env.ANALYTICS_PATH
    ? [{ name: "GET /api/analytics", method: "GET", path: process.env.ANALYTICS_PATH, headers: authHeader(ADMIN_TOKEN) }]
    : []),
];

function requestOnce({ method, path, headers = {}, body }) {
  const url = new URL(path, BASE_URL);
  const lib = url.protocol === "https:" ? https : http;
  const start = performance.now();
  return new Promise((resolve) => {
    const req = lib.request(url, { method, headers }, (res) => {
      res.on("data", () => {}); // drain
      res.on("end", () => resolve({ ms: performance.now() - start, status: res.statusCode }));
    });
    req.on("error", () => resolve({ ms: performance.now() - start, status: 0 }));
    if (body) req.write(body);
    req.end();
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function measure(ep) {
  const samples = [];
  const statuses = {};
  let dispatched = 0;

  async function worker() {
    while (dispatched < N) {
      dispatched += 1;
      const { ms, status } = await requestOnce(ep);
      samples.push(ms);
      statuses[status] = (statuses[status] || 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, N) }, worker));
  samples.sort((a, b) => a - b);
  const round = (x) => Math.round(x * 100) / 100;
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;

  return {
    endpoint: ep.name,
    n: samples.length,
    avg_ms: round(avg),
    p50_ms: round(percentile(samples, 50)),
    p95_ms: round(percentile(samples, 95)),
    p99_ms: round(percentile(samples, 99)),
    statuses: JSON.stringify(statuses),
  };
}

(async () => {
  console.log(`\nAPI latency baseline → ${BASE_URL}  (N=${N} per endpoint, concurrency=${CONCURRENCY})\n`);
  const rows = [];
  for (const ep of endpoints) {
    rows.push(await measure(ep));
  }
  console.table(rows);
  console.log(
    "\nTip: authed endpoints run only when ADMIN_TOKEN + MESSAGES_PATH/ANALYTICS_PATH are set,\n" +
    "and the guest-init probe only when GUEST_INIT_BODY is set. See perf/README.md.\n"
  );
})();
