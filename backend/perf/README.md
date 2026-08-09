# Performance baseline harness (PERF0-1) + DoS probes (SEC26 W4)

## DoS / backpressure probe — `dos-backpressure.mjs`

Proves the origin's flood contract (SEC26 Wave 4): worker-pool saturation →
bounded 503s (`EWORKERBUSY`), hot-read budgets → 429, and `/health` liveness
while the flood runs. Zero dependencies, same rules as the baseline harness —
never point it at production.

```bash
# Local (server on :8787)
node perf/dos-backpressure.mjs

# Staging, with the authed hot-read probe enabled
BASE_URL=https://<staging> GUEST_TOKEN=<jwt> FLOOD_N=2000 FLOOD_CONCURRENCY=200 \
  node perf/dos-backpressure.mjs
```

Exit 0 = contract held. Run before each Render plan change and after any
change to `utils/secretPool` or the limiter stack.

### Denial-of-wallet checklist (quarterly, ~10 min)

- [ ] Render dashboard → instance count & bandwidth: any unexplained step-change?
- [ ] Cloudflare → cache hit ratio on `/api/gold`, `/api/facebook/*`, site-config
      (a hit-ratio collapse = origin pays for every bot request).
- [ ] Firestore usage → reads/day vs. norm (BOLA scans & scrapers show up here).
- [ ] R2/storage egress vs. norm (signed-URL abuse would surface as egress).
- [ ] `security-audit.yml` weekly run still green (its Telegram page is the
      push-side alarm; this checklist is the pull-side audit).

---

Zero-dependency latency probe for the backend API. Built on Node built-ins only — no `npm install` required.

## Run

From the `backend/` directory, with the server running:

```bash
# Local default (http://127.0.0.1:8787), 100 requests/endpoint, concurrency 10
node perf/baseline.mjs

# Custom target + load
BASE_URL=https://staging.example.com N=200 CONCURRENCY=20 node perf/baseline.mjs
```

By default it only probes the public `GET /health` endpoint. Opt into the others
by supplying the inputs explicitly (the harness never fabricates auth or params):

```bash
# Public guest init (POST)
GUEST_INIT_BODY='{"branchEmail":"branch@example.com"}' node perf/baseline.mjs

# Authenticated admin endpoints — provide a token and concrete query paths
ADMIN_TOKEN="<branchadmin-jwt>" \
MESSAGES_PATH="/api/messages?guestId=<id>&branchId=<id>" \
ANALYTICS_PATH="/api/analytics?start=2026-06-01&end=2026-06-09" \
node perf/baseline.mjs
```

## Output

A table of `avg_ms / p50_ms / p95_ms / p99_ms` plus the HTTP status histogram per
endpoint. Record p50/p95 in the **Baseline results** table under PERF0-1 in
`PERFORMANCE-PLAN.md`, then re-run after each optimization to capture the delta.

## Security

- Read-only measurement. Tokens are read from the environment, **never logged or
  written to disk**.
- Point `BASE_URL` at a non-production target for heavy load runs.
- Never commit real tokens. Treat any JWT you pass here as a secret.
