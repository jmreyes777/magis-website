# Magis Pawnshop — Performance & Speed Plan

**Status:** Draft for review
**Scope:** `backend/` (Express + Firebase + Socket.IO), `magis-edge-worker/` (Cloudflare), `admin-frontend/`, `user-frontend/`
**Prepared by:** Engineering (performance review)
**Last updated:** 2026-06-08

> This document is an assessment and action plan. **No application code has been changed** as a result of this review. File/line references point to the current `main` branch. Every recommendation is designed to ship with **zero compromise to the security work** in `SECURITY-REMEDIATION-PLAN.md` (P0–P3); each item states the specific security interaction to preserve.

---

## 1. Executive summary

The platform already has the **hardest performance fundamentals in place**: route-level code splitting (`React.lazy` + `Suspense`) in both SPAs, the tree-shakeable **modular Firebase SDK**, `console.*` stripping in production, edge-side **immutable caching of hashed assets**, and Socket.IO `perMessageDeflate`. This plan therefore targets the **remaining bottlenecks** rather than re-architecting.

The biggest wins, in order of value-for-effort:

- **No response compression at the origin** — gzip/brotli is not enabled for API JSON (quick, high-impact).
- **No Firestore caching + several unbounded queries** — read-heavy near-static lookups hit Firestore on every request, and a few queries read whole collections / full conversations with no `limit` (largest API-latency lever).
- **A single secret-worker thread** serializes every JWT operation across all HTTP and socket auth (throughput ceiling under load).
- **The Workbox service worker is wired but disabled** — enabling it (assets-only) is a large repeat-visit win.

None of the recommended changes require removing features, degrading UX, or weakening any security control. The plan is **sequenced so each phase builds on the previous one** (see §4).

---

## 2. How to read this document

**Impact**

- **High** — materially improves latency, throughput, or page-load for many requests/users.
- **Medium** — meaningful improvement on specific paths or repeat visits.
- **Low** — incremental / hygiene; compounds with the rest.

**Effort**

- **S** — hours; localized change.
- **M** — ~1–2 days; touches multiple files or needs a small abstraction.
- **L** — multi-day; infra or cross-cutting.

**Security-preservation note** — every item states exactly how it ships **without** weakening any P0–P3 control. The two recurring invariants:

- **Caching applies only to public, non-personalized data** — never auth-gated responses, decrypted message content, or JWT-revocation state.
- **HTML stays per-request** — the P3-1 CSP nonce makes `index.html` uncacheable by design; nothing may cache HTML/navigations.

---

## 3. Findings & recommendations

### PHASE 0 — Baseline & guardrails

#### [ ] PERF0-1 — Establish a measurable baseline before any change
- **Where:** `user-frontend/package.json` already ships `source-map-explorer` + `webpack-bundle-analyzer` (`analyze` script); `reportWebVitals.js` exists in both SPAs but is unused.
- **Opportunity:** Without numbers, later phases are guesswork and regressions go unnoticed.
- **Recommendation:** Capture (1) main-chunk sizes via `npm run analyze` for both SPAs, (2) p50/p95 latency on `/api/messages`, `/api/analytics`, `/api/guest/init` with `autocannon`/`k6`, (3) LCP/INP/CLS by wiring `reportWebVitals` to the console or an endpoint.
- **Security-preservation note:** Measurement only — no runtime change.
- **Impact:** High (enables/validates everything else). **Effort:** S
- **Status (2026-06-09):** Instrumentation landed. `reportWebVitals` is now wired **dev-only** in both SPAs with a version-agnostic reporter that emits **INP** on `web-vitals ≥ 3` (and fixed a latent crash — `admin-frontend` ships `web-vitals@4` but its `reportWebVitals.js` still called the removed v2 `getFID`/`getCLS`). Added an `analyze` script to `admin-frontend`, bumped `user-frontend` `web-vitals` `^2.1.4 → ^4.2.4` for INP parity, and added a zero-dependency latency harness at `backend/perf/baseline.mjs`. Numbers below are pending the first capture runs.

**How to capture (this repo):**

- **Bundle main-chunk sizes** — opens an interactive treemap per SPA:
  - `cd user-frontend && npm run analyze`
  - `cd admin-frontend && npm run analyze` *(uses `npx source-map-explorer`)*
- **API latency (p50/p95/p99)** — start the backend, then from `backend/`:
  - `node perf/baseline.mjs` (probes `GET /health`)
  - Authed/parameterized probes via env vars — see `backend/perf/README.md`.
- **Web Vitals (LCP/INP/CLS/FCP/TTFB)** — run a SPA in dev and read the `[web-vitals] …` console lines; production builds stay silent (`NODE_ENV` guard).
- *Note:* `user-frontend` needs `npm install` once to pick up `web-vitals@4` (the reporter still works on v2 meanwhile, just without INP).

**Baseline results (fill in once captured):**

| Metric | user-frontend | admin-frontend |
| --- | --- | --- |
| Main JS chunk (gzip) | _TBD_ | _TBD_ |
| Total JS (gzip) | _TBD_ | _TBD_ |
| LCP | _TBD_ | _TBD_ |
| INP | _TBD_ | _TBD_ |
| CLS | _TBD_ | _TBD_ |

| API endpoint | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | --- | --- | --- |
| GET /health | _TBD_ | _TBD_ | _TBD_ |
| POST /api/guest/init | _TBD_ | _TBD_ | _TBD_ |
| GET /api/messages | _TBD_ | _TBD_ | _TBD_ |
| GET /api/analytics | _TBD_ | _TBD_ | _TBD_ |

### PHASE 1 — Backend quick wins

#### [x] PERF1-1 — Enable response compression at the origin — ✅ DONE 2026-06-09
- **Where:** No `compression` middleware anywhere in `backend/server.js`; not in `backend/package.json`.
- **Opportunity:** Largest single origin win for JSON payloads (analytics, message history) and the origin→edge hop.
- **Recommendation:** Add `compression()` early in the middleware chain.
- **Security-preservation note:** BREACH only applies when a secret and reflected user input share one compressed body. Secrets here live in cookies/headers, not bodies, and Cloudflare already compresses edge→client regardless — so origin compression adds **no new client-facing risk**. To be strict, skip compression on any response that echoes request input alongside a CSRF token.
- **Impact:** High. **Effort:** S
- **Resolution (2026-06-09):** Added `compression@^1.7.4` and mounted `compression()` right after CORS (`backend/server.js:213`) with `threshold: 1024` and a BREACH-hardened `filter` that honors an `x-no-compression` opt-out and **never compresses `GET /api/csrf-token`** (token in body). Static assets + JSON now gzip/br at the origin. Run `npm install` in `backend/` to materialize the dependency.

#### [x] PERF1-2 — Gate request logging by environment — ✅ DONE 2026-06-09
- **Where:** `backend/server.js:258` — `app.use(morgan("dev"))` runs unconditionally.
- **Opportunity:** `dev` format is verbose; per-request string building + I/O on every production request.
- **Recommendation:** Use `morgan("combined")` only when `NODE_ENV !== "production"` (or sample in prod).
- **Security-preservation note:** Logging behavior only; keep security-relevant audit logging intact.
- **Impact:** Low. **Effort:** S
- **Resolution (2026-06-09):** `morgan` is now environment-gated at `backend/server.js:283`. Non-prod keeps `morgan("dev")`; production uses `morgan("combined")` **sampled** (`HTTP_LOG_SAMPLE`, default `0.05`) and skips successful `/health` probes, eliminating per-request verbose logging cost in prod (Cloudflare retains edge access logs). Security/audit logging elsewhere is untouched.

#### [x] PERF1-3 — Add `Cache-Control` to public GET endpoints — ✅ DONE 2026-06-09
- **Where:** Public read endpoints set no cache headers, so neither the edge nor the browser can cache them.
- **Opportunity:** Short caching of public, non-personalized reads (branch status, FAQ-type content) cuts repeat latency and origin load. Produces the headers Phase 5 consumes.
- **Recommendation:** Set `Cache-Control: public, max-age=30, s-maxage=60` on **public** GET responses only.
- **Security-preservation note:** Apply **only** to non-authenticated, non-personalized endpoints. Never on anything behind `authenticateBranchAdmin`/`authenticateSuperAdmin` (would cross-pollute users).
- **Impact:** Medium. **Effort:** S
- **Resolution (2026-06-09):** Added a reusable `backend/middlewares/publicCache.js` factory that stamps `Cache-Control: public, max-age=<m>, s-maxage=<s>` **only on 2xx GET** responses (errors/non-GET → `no-store`, so a transient upstream failure is never cached) and appends `Vary: Origin` (CORS reflects the caller's Origin, so a shared cache must key per-origin; `res.vary()` merges with compression's `Vary: Accept-Encoding`). Applied to the three genuinely public, non-personalized GETs only:
  - `GET /api/branch-status` → `publicCache(30, 60)` (presence; brief TTL, `lastSeen` still exact).
  - `GET /api/facebook/latest-video` → `publicCache(300, 600)` (matches the existing 5-min origin memory cache).
  - `GET /api/facebook/albums/latest/photos` → `publicCache(300, 600)`.
  - **Security hardening alongside:** explicitly set `Cache-Control: no-store` on `GET /api/csrf-token` (secret in body) and `GET /health` (probe), pinning them closed *before* Phase 5 begins honoring public-GET cache hints. **No authenticated route** (analytics, branches, mfa, messages history/all/media/admin-media/conversation-key, branchadmin `/profile`, superadmin `/verify`) was touched. Verified with a 6-case harness (2xx → public+Vary merge; 304/4xx/5xx/POST → no-store).

#### [x] PERF1-4 — Remove dead database dependencies from production — ✅ DONE 2026-06-09
- **Where:** `mongoose`/`mongodb` are imported **only** by the one-off script `backend/addSpaceIdToBranchAndMessages.js`, never on a request path; listed in `backend/package.json` `dependencies`.
- **Opportunity:** Smaller install, faster cold start, lower memory, reduced attack surface.
- **Recommendation:** Move to `devDependencies` (or drop and run the script ad hoc).
- **Security-preservation note:** Net **reduction** in dependency/attack surface; no runtime path affected.
- **Impact:** Low. **Effort:** S
- **Resolution (2026-06-09):** Verified usage repo-wide first: `mongoose` is required **only** by `backend/addSpaceIdToBranchAndMessages.js` (a standalone one-off Mongo→Firestore migration using `process.env.MONGO_URI`), and `mongodb` has **zero** imports anywhere (redundant — mongoose bundles its own driver). The script is referenced by no npm script / Procfile / Dockerfile. Moved both `mongoose@^8.8.2` and `mongodb@^6.10.0` from `dependencies` → `devDependencies` in `backend/package.json` (reversible; keeps the migration script runnable after a dev install). The live app uses `firebase-admin`/Firestore exclusively, so **no runtime/request path is affected**. Run `npm install` in `backend/` to re-sync `package-lock.json`, and deploy with `npm ci --omit=dev` to realize the smaller prod surface.

### PHASE 2 — Data layer (Firestore)

#### [x] PERF2-1 — Introduce a Redis-backed cache for near-static reads — ✅ DONE 2026-06-09
- **Where:** No general cache today; the only example is an in-memory cache for the FB-video endpoint (`backend/server.js:737`). Hot, repeated reads: branch list (`backend/routes/branches.js:65`), `branchAdmins` on login/profile (`backend/routes/branchadminauth.js:65`, `:196`), branch doc on guest init (`backend/routes/guest.js:46`).
- **Opportunity:** These are read on nearly every request but change rarely — caching removes a Firestore round-trip from the hot path.
- **Recommendation:** Generalize the FB-video pattern into a small Redis-backed helper (Redis already exists from P2-1) with a 30–300s TTL and explicit invalidation on write.
- **Security-preservation note:** Cache **only** non-user-specific, non-sensitive data. **Never** cache conversation/message content (sensitive, encrypted at rest), auth decisions, or revocation state. Key entries by branch/role scope.
- **Impact:** High. **Effort:** M
- **Resolution (2026-06-09):** Added a generic **fail-open** read-through helper `backend/utils/cache.js` (`cached(key, ttl, producer)`, `invalidate(...keys)`, `key(...)`): JSON (de)serialize, per-op timeout (`CACHE_OP_TIMEOUT_MS`, default 200ms), throttled logging, and a `CACHE_DISABLED` kill switch. **Any Redis error/outage/timeout transparently falls back to the source read** (verified), so the cache can never break or stall a request; producer errors still propagate; `undefined` (not-found) results are returned but never cached.
  - **Applied to** `backend/routes/branches.js`: `GET /` (`cache:branches:list`) and `GET /:id` (`cache:branches:doc:<id>`), backstop TTL `CACHE_BRANCHES_TTL` (default 300s). **Invalidated** on `POST /` (list), `PUT /:id` and `DELETE /:id` (list + doc) — all writers to the `branches` collection are local to this file, so invalidation is complete. Cached JSON matches the existing `res.json` wire format exactly (incl. Firestore Timestamps), so no client-visible change.
  - **Security decisions (deliberately tighter than the candidate list):** **Excluded** the `branchAdmins` login/profile reads — that doc holds the bcrypt password hash, `failedAttempts`, `lockedUntil`, and MFA secrets; caching it would weaken brute-force lockout and store credentials (this is exactly the "never cache auth decisions / revocation state" rule). **Deferred** `resolveBranchStaffEmail` (guest contact relay, `guest.js:160`) — it reads a branch doc keyed by **email**, distinct from the uuid-keyed writes here, so invalidation wouldn't match (stale email-routing risk) and it's low-frequency (rate-limited 5/10min). New env vars documented in `backend.env.example`. Verified via `node --check` + a 14-case stubbed-Redis harness (hit/miss, negative-cache, single/multi invalidation, producer-error propagation, full fail-open path).

#### [x] PERF2-2 — Bound the full-collection read — ✅ DONE 2026-06-09
- **Where:** `backend/routes/archived.js:12` — `db.collection("messages").get()` reads the **entire** collection; cost grows unbounded with volume.
- **Recommendation:** Add `where`-scoping + `limit` + cursor pagination.
- **Security-preservation note:** Keep existing branch/role scoping filters; pure query-shape change.
- **Impact:** High. **Effort:** S
- **Resolution (2026-06-09):** Clarified scope first: `archived.js` is **not a mounted route** — it's a **one-off migration** (`admin.initializeApp()` + auto-runs `backfillArchivedField()`, imported nowhere), so the unbounded `.get()` is a migration-memory/reliability hazard (it materialized **every** message doc at once and would OOM/fail on a large collection), not a per-request latency cost. Rewrote the read as a **cursor-paginated scan**: `orderBy(documentId).limit(PAGE_SIZE).startAfter(lastDoc)` looping page-by-page, so memory stays bounded to one page regardless of collection size. Behavior preserved: still **idempotent** (only stamps docs missing `archived`), still commits per page within Firestore's 500-op batch limit (`PAGE_SIZE`/`BACKFILL_PAGE_SIZE`, default 500); documentId ordering needs **no composite index**. `where`-scoping doesn't apply (Firestore can't query a *missing* field), so pagination is the correct bound here.
  - **`where`-scoping note:** the actual per-request archive path — `server.js:1019` `POST /api/guest/force-close` — is **already** scoped (`.where("guestId").where("branchEmail")`), i.e. bounded to one conversation, so no query change was needed there. (Pre-existing, separate from PERF2-2: that endpoint reads `guestId`/`branchEmail` from the body without `authenticateGuest`; a hardened, auth'd guest force-close already exists in `routes/guest.js`. Flagging as a security follow-up, not touched here.) No message content is read/logged/egressed by the migration, so no security posture change.

#### [x] PERF2-3 — Paginate conversation fetches — ✅ DONE 2026-06-09 (backend hardening)
- **Where:** `backend/routes/messages.js:641-645` — `guestId`+`branchId`+`orderBy(timestamp)` `.get()` with no limit loads an entire conversation.
- **Recommendation:** Add `limit(N)` + `startAfter` cursor pagination for the dashboard; lazy-load older messages.
- **Security-preservation note:** Retain the `where("branchId", "==", req.branchId)` scoping; do not cache decrypted content.
- **Impact:** Medium–High. **Effort:** M
- **Findings (premise correction):** The **admin dashboard does not use this endpoint** — `Branch-Chat-Dashboard.js:1054` (`fetchMessages`) reads **client-side from Firestore** and is **already bounded** with `limit(100)`. The unbounded backend route `GET /api/messages/history/:guestId` is gated by `authenticateBranchAdmin`+`requireMFA`, yet its only callers are the **guest** chat boxes (`user-frontend` + `magis-edge-worker`, role `user`) — so those calls **appear to 401 today** (guests fall back to sessionStorage + live socket). A service worker also network-first-caches `/api/messages/history` (`magis-edge-worker/public/sw.js:77`).
- **Resolution (2026-06-09 — option: backend hardening only):** Bounded the endpoint **backward-compatibly**: fetch the most-recent page `orderBy("timestamp","desc").limit(N)` (default **200**, hard max **500**), then `reverse()` to ASC so the existing `{ messages }` (ascending) contract is preserved; added additive `hasMore` + `nextBefore` and a `before` (ISO-ts) cursor for future older-message lazy-loading. **Branch scoping unchanged** (`where("branchId","==",req.branchId)`); no decrypted content is cached server-side. Timestamps are ISO strings (`new Date().toISOString()`), so desc ordering + string `startAfter` sort chronologically. No frontend/SW changes (consumers read `body.messages`). Verified `node --check`. **Deferred (separate items):** the guest↔`/history` auth mismatch (correctness/security) and the optional frontend scroll-up lazy-load (would consume `hasMore`/`nextBefore`).

#### [x] PERF2-4 — Replace in-application analytics aggregation — ✅ DONE 2026-06-09
- **Where:** `backend/routes/analytics.js:255-269` and `:357-367` — date-range `messages` scans with no `limit`, aggregated in Node via `forEach`.
- **Recommendation:** Bound the range, and move counting to Firestore **aggregation queries** (`count()`) or pre-computed rollup counters updated on write.
- **Security-preservation note:** Query shape + aggregation only; scoping filters unchanged.
- **Impact:** High (on analytics paths). **Effort:** M
- **Resolution (2026-06-09):** Added two shared helpers — `buildBoundedMessagesQuery()` and `runBoundedAnalyticsQuery()` — and refactored **all four** endpoints (`/message-volume`, `/response-time`, `/conversation-summary`, `/branch-performance`) onto them.
  - **Critical correctness fix (was silently broken):** messages persist `timestamp` as an **ISO-8601 string** (`new Date().toISOString()`), but the range filters compared against **`Date` objects**. By Firestore type-ordering (timestamp-type < string-type) those filters matched **zero** string-typed docs, so every *date-ranged* analytics call returned empty. Now we compare against **ISO strings** (which sort lexicographically === chronologically), so the queries actually return data and ride the PERF2-5 `(branchEmail, timestamp)` composite index.
  - **End-date inclusivity:** the dashboard sends **date-only** strings (`endDate.toISOString().split('T')[0]`, e.g. `2026-06-09`). A date-only upper bound is now extended to **end-of-day** (`T23:59:59.999Z`) so the final day's messages are included (previously a midnight bound would have excluded "today").
  - **Bounded scans:** every scan is now time-bounded (explicit range, or a default **`ANALYTICS_DEFAULT_DAYS`=90** lookback when none is supplied — note the frontend always supplies a range, so this is just a safety net) **and** hard-capped at **`ANALYTICS_MAX_DOCS`=20000** docs. Both are env-tunable.
  - **`count()` aggregation:** accurate match totals (`totalMessages`) now come from a `count()` aggregation (no doc transfer) for `/message-volume` and `/branch-performance`; a capped, `timestamp`-ordered doc slice still feeds the per-day / per-guest / per-branch breakdowns that Firestore aggregation can't express (no GROUP BY / DISTINCT). Responses gained additive `window:{start,end}` and `truncated` (true when the scan hit the cap). `firebase-admin@^13.10.0` supports `count()`.
  - **Security/scoping unchanged:** `where("branchEmail","==",…)` applied exactly as before (and omitted for the superadmin `/branch-performance`, same as before). **Verified** `node --check`. **Not changed:** `/debug` (already `.limit(5)`). **Flagged (separate, not fixed):** `analytics.js:8` defines `devLog` as `(...args) => { if (isDev) devLog(...args); }` — a self-recursive no-op that would infinite-loop if `NODE_ENV=development` (harmless in prod where `isDev` is false); should call `console.log`.

#### [x] PERF2-5 — Commit composite index configuration — ✅ DONE 2026-06-09
- **Where:** No `firestore.indexes.json`/`firebase.json` in the repo; multi-`where`+`orderBy` queries (e.g. `messages.js:641-645`, analytics timestamp+branch) require composite indexes.
- **Recommendation:** Commit an index config so required indexes are reproducible and queries stay fast.
- **Security-preservation note:** Indexing only; no data exposure or rule change (Firestore security rules unaffected).
- **Impact:** Medium. **Effort:** S
- **Resolution (2026-06-09):** Audited **every** Firestore query repo-wide (backend routes + `utils/socket.js` + `server.js`, and the client-side SDK queries in `admin-frontend`/`user-frontend`/`magis-edge-worker`, which hit the same database). Equality-only (multi-`==`) and single-field queries need **no** composite index (auto single-field indexes + zigzag merge), so the required set reduces to **3** composite indexes on `messages`, committed in `firestore.indexes.json` (+ minimal `firebase.json` referencing it) at the repo root:
  - `(branchEmail ASC, timestamp ASC)` — serves the analytics range scans `where(branchEmail==)+where(timestamp >=/<=)` (`analytics.js:69-77`, `:152-158`, `:261-266`) **and** the dashboard conversation-list `where(branchEmail==)+orderBy(timestamp desc)` (`Branch-Chat-Dashboard.js:863`) via Firestore **reverse-index traversal** (equality filter has no direction, so one ASC index covers both timestamp directions — avoids a redundant DESC index on this high-write collection).
  - `(guestId ASC, branchId ASC, timestamp DESC)` — backend `GET /history/:guestId` (`messages.js:648-650`, the PERF2-3 desc query).
  - `(guestId ASC, branchEmail ASC, timestamp ASC)` — dashboard `fetchMessages` + BC-sync (`Branch-Chat-Dashboard.js:1056-1058`, `:1675-1677`).
  - **Not indexed (intentionally):** equality-only combos — `socket.js` seen/unseen + sender filters, `server.js:1021` force-close, guest-chat `where(guestId==)+where(branchEmail==)`, `analytics.js:363-364` single-field timestamp range, and `branchAdmins`/`tempId` single-`==` lookups. **Deploy:** `firebase deploy --only firestore:indexes --project <FIREBASE_PROJECT_ID>` (no `.firebaserc` committed — project id stays env-specific). JSON validated via `node`. **Observation (ties to PERF2-4, not fixed here):** analytics filters `timestamp` against `Date`/Timestamp values while writes store **ISO strings** (`new Date().toISOString()`) — a type mismatch that likely makes those range queries return nothing regardless of the index; flagged for the PERF2-4 analytics rework. Rules unaffected (none in repo).

### PHASE 3 — Concurrency & scaling

#### [x] PERF3-1 — Convert the secret worker to a small pool — ✅ DONE 2026-06-09
- **Where:** `backend/utils/secretPool.js:13` — a **single** worker thread; every JWT sign/verify/revoke for all HTTP + socket auth serializes through it (each call also does a Redis revocation round-trip).
- **Recommendation:** Round-robin pool of N workers (e.g. `JWT_WORKER_POOL=4`) reusing the same worker file and message protocol.
- **Security-preservation note:** **Identical** isolation model — the signing secret stays inside worker threads, never on the main thread; same per-call verify + revocation logic. Pure throughput change.
- **Impact:** High (under concurrency). **Effort:** M
- **Resolution (2026-06-09):** Replaced the single `worker` with a **round-robin pool** of `JWT_WORKER_POOL` (default **4**, min 1) identical workers reusing the **same** `workers/secretWorker.js` and message protocol (unchanged). Public API (`signJWT`/`verifyJWT`/`revokeJWT`/`signGuestJWT`/`signAdminJWT`/`shutdown`/`_defaults`) is **byte-for-byte the same** for all callers (middlewares, `server.js`, `socket.js`).
  - **`sign`/`verify` → round-robin** (`pickWorker()`) across the pool — this is the parallelized hot path.
  - **`revoke` → BROADCAST to every worker** (`broadcastToPool()`, resolves via `Promise.all`). **Why this matters for security:** each worker keeps its own `revokedInMemory` Set (the fallback used only when Redis is unreachable). A naive round-robin pool would let a `revoke` land on worker A while a later `verify` for the same `jti` routes to worker B → **a revoked token could be accepted during a Redis outage**. Broadcasting keeps every worker's fallback consistent, so the single-worker revocation guarantee is preserved **exactly**. (When Redis is up it remains the shared source of truth across workers *and* instances, unchanged.) `revoke` is rare, so the N× fan-out + idempotent per-worker Redis `SET` is negligible.
  - **Resilience:** callbacks now track their owning worker (`workerIndex`); a worker `error`/`exit` rejects **only that worker's** in-flight calls (not the whole pool), and the slot is nulled so the next dispatch lazily respawns a replacement. `shutdown()` terminates all workers.
  - **Cost note:** N workers = **N Redis connections** for revocation (one per thread) and N idle threads; default 4 is modest. Tune via `JWT_WORKER_POOL` (set `1` for legacy behavior). **Verified** `node --check` + module load (exports intact, `POOL_SIZE` reported in `_defaults`). Env documented in `backend.env.example`. Touches `backend/` → will trigger a Render deploy.

#### [x] PERF3-2 — Enable horizontal / multi-process scaling — ✅ DONE 2026-06-09 (horizontal / Render multi-instance)
- **Where:** `backend/package.json:35` — `start` is a bare `node server.js` (single process).
- **Opportunity:** Rate-limiting + revocation are Redis-backed and Socket.IO uses `@socket.io/redis-adapter`, so scaling out is now safe (it was not pre-P2-1).
- **Recommendation:** Run multiple Render instances or Node `cluster` workers behind the existing edge.
- **Security-preservation note:** The cluster-safety guarantees from P2-1 are exactly what make this safe — no control degrades to per-instance. Each process spawns its own secret-worker pool.
- **Impact:** High (capacity). **Effort:** M
- **Audit finding — already multi-instance-safe:** a full pass found the backend needs **no app rearchitecting** to scale horizontally. (1) All shared control state is Redis-backed (P2-1): rate-limiting, JWT revocation, Socket.IO adapter, branch presence (TTL keys), undelivered queue. (2) **Every** Socket.IO client connects with `transports:['websocket']` (8 call sites across `admin-frontend`, `user-frontend`, `magis-edge-worker`) — a WebSocket is one TCP connection pinned to a single instance for its lifetime, so **no sticky sessions** are needed; the `@socket.io/redis-adapter` (`utils/socket.js:216`) fans out cross-instance broadcasts. (3) The in-memory maps in `socket.js` are explicitly per-process ephemeral conveniences; cross-instance correctness goes through Redis. (4) The `setInterval` heartbeat/cleanup sweeps (`socket.js:903,959`) are correctly per-process scoped.
- **Resolution (2026-06-09 — chosen approach: Render multi-instance):**
  - **Server-side hardening (`utils/socket.js:201-213`):** pinned `transports:['websocket']` + `allowUpgrades:false` on the Socket.IO `Server`. No-op for real traffic (clients are already WS-only) but it guarantees the safety property above — a stray client/proxy can no longer silently fall back to HTTP long-polling against a non-sticky multi-instance backend (which would break the session). Verified `node --check`.
  - **IaC (`render.yaml` at repo root, NEW):** a non-destructive Render Blueprint for the `web` service (`rootDir: backend`, `startCommand: npm start`, `healthCheckPath: /health`) with a `scaling` block (`minInstances:1`, `maxInstances:3`, `targetCPUPercent:70`). Secrets are `sync:false` (values stay dashboard-managed, none committed); env-specific fields (`plan`/`region`/`branch`) are flagged "VERIFY". Validated by parsing with `js-yaml`. **It does not alter the running service until connected/synced as a Blueprint in Render.**
- **Operator steps to actually scale out (not code):** (1) provision managed Redis + set `REDIS_URL`, then set **`REQUIRE_REDIS=true`** so degradation can't go unnoticed; (2) ensure plan is **Standard+** (autoscaling requirement); (3) review/sync `render.yaml` as a Blueprint **or** just raise the instance count in the dashboard. Cross-host redundancy + zero-downtime deploys come from `minInstances >= 2`.
- **Pre-existing caveat noted (not introduced here):** `routes/archived.js:57` runs `backfillArchivedField()` at module load (every boot). Idempotent, so fine for multi-**instance** (each instance boots once); it would only need primary-only guarding under in-process Node `cluster` (the approach NOT chosen).

### PHASE 4 — Frontend delivery

#### [x] PERF4-1 — Enable and tune the Workbox service worker — ✅ DONE 2026-06-09 (SW authored + footgun removed; PROD-ENABLE deferred to operator)
- **Where:** Wired but opt-in/likely off — `user-frontend/src/index.js:52` gates registration on `REACT_APP_ENABLE_SW === 'true'`.
- **Recommendation:** Enable with a precache of **hashed static assets** + runtime caching for images/fonts. Large repeat-visit win.
- **Security-preservation note (critical):** The SW must be **network-only/network-first for HTML navigations** and must **never cache `index.html`**. The P3-1 CSP uses a per-request nonce; a cached HTML page would carry a stale nonce and the CSP would block your own scripts. Caching only hashed (nonce-independent) assets avoids this entirely.
- **Impact:** High (repeat visits). **Effort:** M
- **Premise correction (audit 2026-06-09):** there was **no Workbox SW to "enable + tune."** `src/service-worker.js` (CRA InjectManifest source) does **not** exist, so InjectManifest never runs (the `craco.config.js` block only silences a leftover warning); the `workbox-*` packages are installed but unused. `public/` shipped **two** hand-written workers: `sw.js` (a kill-switch) and an **orphaned `service-worker.js`** that precached `/index.html` and was **cache-first for everything** — the almost-certain cause of the prior prod breakage (stale CSP nonce → blocked scripts) that led to the kill-switch + `REACT_APP_ENABLE_SW=false`. `ServiceWorkerRegistration.js` + the token/CSRF SW-messaging in `tokenManager.js` are **dead code** (mounted nowhere). CSP per-request nonce confirmed (`server.js:323,340`).
- **Resolution (2026-06-09 — chosen approach: build safe SW, keep gated OFF):**
  - **`public/sw.js` rewritten** into a safe-by-design, dependency-free worker: cache-first for **only** same-origin `/static/*` (content-hashed/immutable JS+CSS), same-origin images, and same-origin fonts, each with FIFO entry caps. It **never** calls `respondWith` for navigations (`request.mode==='navigate'` → network → fresh nonce), non-GET, cross-origin (no opaque caching), or API requests. `activate` purges any non-allowlisted cache (cleans up the old broken `v1` cache); honors the `'SKIP_WAITING'` message `index.js` already posts.
  - **`public/service-worker.js` neutralized** into a kill-switch (legacy URL): unregisters + purges + reloads, so any browser still controlled by the old cache-first worker **self-heals** on its next update check. Removes the footgun without deleting the URL (a 404 would NOT unregister a stuck worker).
  - **Production behavior is UNCHANGED on deploy:** `REACT_APP_ENABLE_SW` stays `false` in `.env`, `.env.example`, **and `.env.production`**, so `index.js` keeps unregistering/purging exactly as before. The new worker only activates once the flag is deliberately set to `true`. Both files pass `node --check`.
- **Operator enable step (deliberate, not done here):** verify on a staging/preview build first, then set `REACT_APP_ENABLE_SW=true` (ideally `.env.production`). Recommended check: DevTools → Application → Service Workers shows `/sw.js` active; navigations return a **fresh** `index.html` (200, new nonce, not "from ServiceWorker"); only `/static/*`, images, fonts are served from cache; the CSP throws no nonce errors.

#### [ ] PERF4-2 — Remove server-only packages from the browser bundles
- **Where:** Both SPAs list `socket.io` (the server), `express`, `multer`, `mongoose` in dependencies (`user-frontend/package.json`, `admin-frontend/package.json`).
- **Recommendation:** Confirm unimported in browser code and remove.
- **Security-preservation note:** Reduces install + potential bundle surface; no runtime feature affected.
- **Impact:** Low–Medium. **Effort:** S

#### [ ] PERF4-3 — Keep heavy route-local libraries out of the main chunk
- **Where:** `recharts` (admin analytics), `@react-google-maps/api` (branches), `framer-motion` — already route-split.
- **Recommendation:** Verify via the analyzer they are not in the shared/main chunk; lazy-load Google Maps only on the branches route.
- **Security-preservation note:** Bundling only; CSP already allows the relevant Google origins.
- **Impact:** Medium. **Effort:** S–M

#### [ ] PERF4-4 — Add connection hints
- **Where:** `index.html` in both SPAs.
- **Recommendation:** `preconnect`/`dns-prefetch` for `*.googleapis.com`, `*.gstatic.com`, and Firebase endpoints to cut TLS-setup latency.
- **Security-preservation note:** Only origins already permitted by the CSP; no policy widening.
- **Impact:** Low–Medium. **Effort:** S

#### [ ] PERF4-5 — Optimize image assets
- **Where:** `src/assets/` in both SPAs.
- **Recommendation:** Serve WebP/AVIF at correct dimensions (the apps already depend on `browser-image-compression` for uploads).
- **Security-preservation note:** Static asset processing only.
- **Impact:** Medium. **Effort:** S–M

### PHASE 5 — Edge / network polish

#### [ ] PERF5-1 — Edge-cache public API GETs
- **Where:** The edge forwards origin `Cache-Control` via `minimalResponse` (`magis-edge-worker/index.js:282`) but force-caches only when `isProdAsset` (`:284`).
- **Recommendation:** Once PERF1-3 adds `s-maxage` to public GETs, optionally enable Cloudflare edge caching for those paths.
- **Security-preservation note:** Restrict to public endpoints; never cache responses with `Set-Cookie` or that vary on `Authorization`.
- **Impact:** Medium. **Effort:** S

#### [x] PERF5-2 — Static/HTML caching is already optimal (no action)
- **Where:** Hashed assets are `immutable` (`magis-edge-worker/index.js:392`); HTML is `no-cache` (`:394`) **by design** for per-request nonces; the nonce rewrite reads the body once (`:415`).
- **Note:** Keep `index.html` small so the per-request `resp.text()` rewrite stays cheap. This is a deliberate security/perf tradeoff (P3-1), not a bug — left as-is.
- **Impact:** — **Effort:** —

---

## 4. Sequencing & dependencies

The order is dependency-driven, not just priority — each phase enables or de-risks the next:

- **Phase 0 (measure)** → prerequisite for validating every later change and catching regressions.
- **Phase 1 (compression + cache headers)** → fast and low-risk; **produces the origin `Cache-Control` headers that Phase 5 consumes**.
- **Phase 2 (cache layer + bounded queries + indexes)** → the biggest latency lever; needs no new infra (reuses P2-1 Redis).
- **Phase 3 (worker pool + scale-out)** → parallelizes/scales a now-**correct** backend; relies on the cluster-safety established in P2-1.
- **Phase 4 (frontend)** → validated against the **Phase 0 bundle baseline**.
- **Phase 5 (edge caching)** → depends on **Phase 1**'s public-GET headers.

```
Phase 0  ──►  Phase 1  ──►  Phase 5
   │            │
   ├──►  Phase 2  ──►  Phase 3
   └──►  Phase 4
```

---

## 5. Performance roadmap

**Phase 0 — Baseline**
- [ ] PERF0-1 Bundle analysis (both SPAs) + API latency + Web Vitals captured

**Phase 1 — Backend quick wins**
- [x] PERF1-1 Origin compression
- [x] PERF1-2 Environment-gated logging
- [x] PERF1-3 `Cache-Control` on public GETs — ✅
- [x] PERF1-4 Remove dead `mongoose`/`mongodb` from prod deps — ✅ (run `npm install` to re-sync the lockfile)

**Phase 2 — Data layer**
- [x] PERF2-1 Redis-backed cache for near-static reads — ✅ (branches list/doc; fail-open)
- [x] PERF2-2 Bound `archived` full-collection read — ✅ (cursor pagination; one-off migration)
- [x] PERF2-3 Paginate conversation fetches — ✅ (backend /history bounded + cursor; dashboard already limit(100))
- [x] PERF2-4 Firestore aggregation for analytics — ✅ (ISO-string timestamp fix + bounded scans + count(); env: ANALYTICS_MAX_DOCS/ANALYTICS_DEFAULT_DAYS)
- [x] PERF2-5 Commit composite index config — ✅ (3 `messages` composite indexes; firebase.json)

**Phase 3 — Concurrency & scaling**
- [x] PERF3-1 Secret-worker pool — ✅ (round-robin sign/verify, broadcast revoke; JWT_WORKER_POOL=4; API unchanged)
- [x] PERF3-2 Horizontal / multi-process scaling — ✅ (already Redis+WS-safe; pinned server WS transport + render.yaml scaling Blueprint; operator sets instances/Redis)

**Phase 4 — Frontend delivery**
- [x] PERF4-1 Enable + tune Workbox SW (assets-only) — ✅ (safe asset-only SW authored at public/sw.js + orphaned cache-first SW neutralized; still gated OFF — operator flips REACT_APP_ENABLE_SW after staging check)
- [ ] PERF4-2 Remove server-only packages from bundles
- [ ] PERF4-3 Keep heavy libs out of the main chunk
- [ ] PERF4-4 Connection hints (`preconnect`/`dns-prefetch`)
- [ ] PERF4-5 Image optimization

**Phase 5 — Edge / network**
- [ ] PERF5-1 Edge-cache public API GETs
- [x] PERF5-2 Static/HTML caching already optimal (no action)

---

## 6. Measurement & verification

- **Per item:** re-run the relevant Phase 0 measurement before/after and record the delta in the item's entry (mirroring the "Resolution/Verified" style used in `SECURITY-REMEDIATION-PLAN.md`).
- **Targets to watch:** main-chunk size (SPAs), API p95 (messages/analytics/guest-init), LCP/INP, Firestore read counts per request, and origin CPU under load.
- **Regression guardrails:** keep the security smoke checks green; specifically re-verify after PERF4-1 that production HTML is **not** served from the SW cache (CSP nonce must remain per-request) and after any caching work that **no authenticated/personalized response is cached**.

---

## 7. Notes & assumptions

- File/line references reflect `main` at the time of review and may drift as code changes.
- The public site reads some branch data directly via the **client Firestore SDK** (`firebase/firestore` is in the user bundle), which already offloads those reads from the backend; PERF2-1 targets the **server-side** read paths.
- In production the SPAs are served via the edge/static hosts (not `backend/`'s `express.static`, whose path is preceded by a `Content-Type: application/json` middleware at `backend/server.js:272`); performance recommendations target the real serving path.
- This plan changes **no security control**. Where performance and security interact (compression/BREACH, caching scope, SW + CSP nonce), the safe configuration is stated inline and must be honored.
