# Observability Plan (implemented July 2026)

Self-contained, zero-vendor observability for the Magis site: client error
telemetry, backend error alerting, RUM aggregation, an edge uptime watchdog,
post-deploy verification, and a super-admin dashboard. Telegram is the primary
alert channel. Companion docs: `PERFORMANCE-PLAN.md`, `SEO-OPTIMIZATION-PLAN.md`.

## Architecture at a glance

```
 visitor browser ──sendBeacon──▶ /api/rum            ─▶ log line + rumDaily rollup (5-min flush)
                 ──sendBeacon──▶ /api/client-errors  ─▶ log line + clientErrors doc + R6 spike alert
 backend process ──uncaught/5xx─▶ securityAlerts (Telegram/email, Redis-throttled)
 edge worker cron (*/5) ─▶ /health + site check ─▶ Telegram direct + obsIncidents on recovery
 GitHub Action (push to main) ─▶ prod assertions ─▶ Telegram + job failure
 super-admin ─▶ /admin/observability ─▶ GET /api/obs/summary (health, rollups, errors, incidents)
```

## Waves (all implemented)

| Wave | What | Where |
|---|---|---|
| OBS1 | Client error reporter (window errors, promise rejections, ErrorBoundary, hydration `onRecoverableError`); intake with clamps/log/Firestore/spike alert | `user-frontend/src/utils/errorReporter.js`, `src/index.js`, `src/Shared/ErrorBoundary-Component.js`, `backend/routes/clientErrors.js`, `server.js` (limiter + mount) |
| OBS2 | `uncaughtException`/`unhandledRejection` → alert; 5xx spike detector; enriched `/health` (rssMb, redis, version) | `backend/server.js` |
| OBS3 | RUM daily rollups: in-memory accumulator → 1 merged increment write / 5 min → `rumDaily/{YYYY-MM-DD}` (Asia/Manila), histogram buckets + ratings | `backend/routes/rum.js` |
| OBS4 | Keep-warm cron evolved into watchdog: 2 consecutive fails → Telegram from the edge (KV-throttled 1/30min/target), recovery message + incident POST | `magis-edge-worker/index.js`, `deploy-api.mjs` (cron `*/5`, new bindings) |
| OBS5 | Post-deploy verification through the prod worker (200s, prerender non-empty, JSON-LD, /health, sitemap, guide). **Manual-dispatch only until the prod domain cutover** (push trigger commented out — would false-alarm while www.magispawnshop.com serves the old stack) | `.github/workflows/post-deploy-verify.yml` |
| OBS6 | Super-admin API + dashboard | `backend/routes/obs.js`, `admin-frontend/src/pages/Observability-Page.js`, `App.js` route, `AdminNavigation` link |
| OBS7 | This document | — |

## Alert rules

| Rule key | Source | Trigger | Channel |
|---|---|---|---|
| R1–R5 (security megaplan) | backend | already wired | activated by the same Telegram env vars |
| `client-error-spike` (R6) | `routes/clientErrors.js` | ≥ `CERR_SPIKE_THRESHOLD` (10) accepted beacons / 15 min | Telegram/email via `securityAlerts` |
| `backend-exception` | `server.js` | any uncaughtException / non-Redis unhandledRejection | Telegram/email (4/hr cap) |
| `backend-5xx-spike` | `server.js` | ≥ `OBS_5XX_THRESHOLD` (15) 5xx responses / 15 min | Telegram/email |
| watchdog DOWN / RECOVERED | worker cron | 2 consecutive failed checks (≈10–15 min) | Telegram **direct from the edge** |
| post-deploy verify | GH Action | any prod assertion fails after a push to main | Telegram + GitHub email |

## Data model (Firestore)

| Collection | Doc | Writer | TTL field |
|---|---|---|---|
| `clientErrors` | one per beacon (capped `CERR_FS_MAX_PER_HOUR`/hr, default 200) | `routes/clientErrors.js` | `expireAt` (+30 d, `CERR_RETENTION_DAYS`) |
| `rumDaily` | `{YYYY-MM-DD}` with per-metric `{count, good, ni, poor, b0..bN}` | `routes/rum.js` flusher | `expireAt` (+90 d, `RUM_ROLLUP_RETENTION_DAYS`) |
| `obsIncidents` | one per outage window (written on recovery) | worker → `POST /api/obs/incidents` | `expireAt` (+180 d, `OBS_INCIDENT_RETENTION_DAYS`) |

Enable Firestore **TTL policies** on `expireAt` for all three collections
(Console → Firestore → TTL) — same mechanism as `auditLogs`.

## One-time operator setup

1. **Telegram bot (~5 min)**
   - In Telegram, message **@BotFather** → `/newbot` → copy the bot token.
   - Message your new bot once (any text), then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
2. **Render env (backend)** — add and redeploy:
   - `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` (this also activates
     the existing security alerts R1–R5; email transport stays as fallback via
     `SECURITY_ALERT_EMAIL` / first `SUPERADMIN_EMAILS` entry).
   - Optional tuning: `CERR_LOG_SAMPLE`, `CERR_RL_MAX`, `CERR_FS_MAX_PER_HOUR`,
     `CERR_SPIKE_THRESHOLD`, `OBS_5XX_THRESHOLD`, `RUM_ROLLUP_FLUSH_MS`,
     `OBS_SHARED_SECRET` (defaults to `EDGE_SHARED_SECRET`).
3. **Worker bindings** — in `magis-edge-worker/.env` add
   `ALERT_TELEGRAM_BOT_TOKEN=…`, `ALERT_TELEGRAM_CHAT_ID=…` and (production
   worker only) `WATCH_SITE_URL=https://www.magispawnshop.com/`, then run
   `node deploy-api.mjs` (registers the `*/5` cron and bindings; absent values
   are simply skipped — the watchdog degrades to keep-warm logging).
4. **GitHub secrets** — repo → Settings → Secrets → Actions:
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional; the job still fails
   loudly without them and GitHub emails the committer).
5. **Firestore TTL policies** on `clientErrors`, `rumDaily`, `obsIncidents`
   (field `expireAt`).

## Verification / test drills

- **Client error path**: in the prod site console run
  `setTimeout(() => { throw new Error("obs test"); })` → expect a
  `{"t":"cerr"…}` log line in Render, a `clientErrors` doc, and the error on
  `/admin/observability`. Eleven distinct errors within 15 min → exactly one
  Telegram spike alert.
- **Hydration watchdog**: any future prerender drift surfaces as
  `type:"hydration"` rows on the dashboard (React recoverable errors).
- **Uptime drill**: suspend the Render backend for ~15 min → Telegram DOWN
  alert; resume → RECOVERED message + an `obsIncidents` row on the dashboard.
- **Deploy check**: Actions → "Post-deploy verify" → Run workflow (manual
  dispatch) — should pass green in ~6 min against the live site.
- **RUM rollups**: browse the prod site, wait ≤5 min, confirm a
  `rumDaily/{today}` doc and the Web Vitals table on the dashboard.

## Contracts (do not regress)

- Telemetry is fire-and-forget **everywhere**: never throws, never blocks a
  request/response, never awaited on hot paths (mirrors `auditLog.js`).
- No PII: clamped messages/stacks, path only (no query strings), no
  cookies/tokens; UA truncated.
- No CSP changes, no new runtime vendors, no new npm dependencies.
- Public intakes are rate-limited (`rl:cerr:`), clamped, `204`-always.
- Firestore writes are capped (`CERR_FS_MAX_PER_HOUR`, 288 rollup writes/day
  ceiling, incidents only on recovery).
- Watchdog KV usage: 0 writes per run in healthy steady state (`obs:st:*`
  written only while a target is failing).
- Prerender/hydration invariants (SEO megaplan) untouched: the reporter is
  inert when `window.__PRERENDER__` is set.
