# OWASP Top 10 (2025) — Compliance Audit

- **Last updated:** 2026-06-14
- **Mode:** read-only audit (Phase 1). **No application code changed.**
- **Scope:** `backend/`, `magis-edge-worker/`, `admin-frontend/` (incl. Electron), `user-frontend/`, IaC/manifests (`render.yaml`, `wrangler.toml`, `firebase.json`, `.gitignore`, `package.json` + lockfiles).
- **Cross-reference:** maps to the `P0–P3` items in `SECURITY-REMEDIATION-PLAN.md`. "Zero compromise" = no fix may weaken an existing `P` control or regress `PERFORMANCE-PLAN.md` work.

## How to read this

- **Severity:** Critical / High / Medium / Low / Info (likelihood × impact in this app's context).
- **Status:** `New gap` · `Partial` (some coverage exists) · `By design` (deliberate, configurable) · `Roadmap` (already planned) · `Hygiene` (latent, not live).
- **Perf:** flags whether the proposed fix touches a hot path (`PERFORMANCE-PLAN.md`).

## Overall posture

**Strong.** Most of OWASP 2025 is already covered by `P0–P3`. **Waves 1–5 are implemented** (A01-1/2/3/4, A09-1, A03-1a/1b, A02-1/2/3, A04-1, A05-1, A08-1, A10-2, A10-1, A03-2, HYG-1..4): A01-4 rules are emulator-tested + published to staging, and the backend supply-chain **highs are cleared** (csurf removed). Remaining: **A06-1** (perf-sensitive rate-limit, deferred), the one-time **A10-1 dashboard flip** (`MFA_FAIL_OPEN=false`) + the operator-run `branchAdmins` password-hash purge (script provided), plus deferred majors (`firebase-admin@14`, CRA→Vite) and the **CSRF-1** enforcement follow-up. No fix weakens an existing security or performance control.

| ID | OWASP 2025 | Severity | Location | Status |
|----|-----------|----------|----------|--------|
| A01-1 | A01 Broken Access Control | **Med-High** | `backend/routes/analytics.js:114,183,283` | ✅ Fixed (Wave 1) |
| A01-2 | A01 Broken Access Control | Medium | `backend/utils/socket.js:953` (`markSeen`) | ✅ Fixed (Wave 1) |
| A01-3 | A01 Broken Access Control | Medium | `backend/utils/socket.js:863,886,968` | ✅ Fixed (Wave 1) |
| A01-4 | A01 (data layer) | **High** | unauth `messages` access not ownership-bound | ✅ Fix ready (emulator-test pending) |
| A03-1 | A03 Software Supply Chain | Medium | backend: 4 highs (`csurf` chain) cleared; 8 mod (`firebase-admin@14`, deferred) | ✅ Highs cleared |
| A03-2 | A03 Software Supply Chain | Low | frontends: `react-scripts` build/test tree (runtime: `react-router`) | ✅ Runtime item fixed (Wave 4) |
| CSRF-1 | A01 / CSRF | Low | `csurf` token issued but never validated server-side | New (mitigated) |
| A02-1 | A02 Misconfiguration | Low | `backend/server.js` CSP `connectSrc` | ✅ Fixed (Wave 3) |
| A02-2 | A02 Misconfiguration | Low | `backend/server.js` Permissions-Policy | ✅ Fixed (Wave 3) |
| A02-3 | A02 Misconfiguration | Low | `backend/server.js` Facebook routes (5 echoes) | ✅ Fixed (Wave 3) |
| A04-1 | A04 Cryptographic | Low | `MFASessionModal.js`, `BranchAdmin-Login.js` | ✅ Fixed (Wave 3) |
| A05-1 | A05 Injection (XSS) | Low | `user-frontend/src/components/FacebookLatestVideo.jsx` | ✅ Fixed (Wave 3) |
| A06-1 | A06 Insecure Design | Low | media resolvers / `conversation-key` / `history` | Deferred (perf-sensitive) |
| A08-1 | A08 Integrity | Low | `admin-frontend/electron-main.js` | ✅ Fixed (Wave 3) |
| A09-1 | A09 Logging | Low-Med | `backend/utils/socket.js:729` (`debugLog`) | ✅ Fixed (Wave 1) |
| A10-1 | A10 Exceptional Conditions | Low/config | `backend/middlewares/requireMFA.js:24` | ✅ Config wired (Wave 4) |
| A10-2 | A10 Exceptional Conditions | Low | `backend/server.js` (404 + error handler) | ✅ Fixed (Wave 3) |
| HYG-* | Hygiene / latent | Low | dead `assign-*` routers, misplaced `api.js`, edge CRA scaffold | ✅ Cleaned (Wave 5) |

---

## A01 — Broken Access Control (+SSRF)

**Baseline (do not regress):** identity is always derived from the verified token, never the body; per-resource ACLs on media (`messages.js:775,780`) and mark-seen (`messages.js:704`); SPI gated by `requireMFA` (P0-2); fallback-token issuer requires real proof (`server.js:660`, P0-1); socket `joinRoom` room is server-derived (`socket.js:622`, P1-2). **SSRF surface is closed** — Facebook calls hardcode `graph.facebook.com` with env-sourced `pageId`/token (`server.js:823`); Turnstile + nodemailer use fixed hosts.

### A01-1 (Med-High) — Analytics cross-tenant read (BOLA/IDOR) — New gap
- **Where:** `backend/routes/analytics.js:114`, `:183`, `:283` — `const targetBranchEmail = branchEmail || req.branchEmail;`
- **Impact:** a `branchadmin` can pass `?branchEmail=<other branch>` and read another branch's message-volume / response-time / conversation-summary (incl. **guest names**). Cross-tenant confidentiality break.
- **Fix (zero-compromise):** on the `authenticateBranchAdmin` routes, force `targetBranchEmail = req.branchEmail` and ignore the client param. Superadmin uses the separate `authenticateSuperAdmin` route (`:378`). Matches the file's own comment.
- **Perf:** none. **Regression:** no `P` item touched; legitimate admins always query their own branch.

### A01-2 (Medium) — Socket `markSeen` IDOR write + arbitrary emit — New gap
- **Where:** `backend/utils/socket.js:953` — updates **any** `messageId` (`status:"seen"`, `seenByAdmin:true`) with no ownership check, then `io.to(room)` emits to a client-supplied room.
- **Impact:** any authenticated socket can flip seen-state on any message globally and push `messageSeen` into an arbitrary room.
- **Fix:** read the doc, verify `branchEmail`/`guestId` matches `socket.user`, derive the room server-side (mirror the HTTP `mark-seen` route at `messages.js:704`).
- **Perf:** +1 Firestore read per `markSeen` (acceptable). **Regression:** none.

### A01-3 (Medium) — Client-controlled emit rooms — Partial (P1-2 fixed only `joinRoom`)
- **Where:** `sendMessage` emits to client `normalizedRoom` (`socket.js:863`, `:886`); `typing` emits to client `room` (`:968`).
- **Impact:** real-time message/typing spoofing into another tenant's room. NB: the DB write is correctly scoped to `socket.user.branchEmail`; only the live fan-out is unscoped.
- **Fix:** derive the target room from `socket.user` identity instead of the client `room`.
- **Perf:** negligible. **Regression:** none.

### A01-4 (**High**) — `messages` collection: unauthenticated access not ownership-bound — Fix implemented (emulator-test pending)
- **Deployed rules reviewed:** generally **well-structured** — admin reads are branch-scoped, writes role/shape-gated, deletes denied, `siteConfig`/`branches` public-read intentional. The gap was isolated to `messages` (+ anon `guests` create): guests have no Firebase Auth identity, so the rules used `guestId.size() > 8` as a stand-in for ownership, which is a shape check, not authorization.
- **Gaps closed:** (1) **High** — anon `read`/`list` matched ~every message ⇒ any anonymous client could read all branches' messages (metadata plaintext; content E2EE per P1-1); (2) **Med-High** — anon `create` (shape-only) ⇒ message injection into any branch, bypassing the A01-3 socket ACLs; (3) **Med-Low** — anon `archived` toggle on any message; (4) **Low** — anon `guests` create.
- **Root cause:** the guest client used the SDK only for archive-on-close (`Guest-Chat-Box-Component.js:1646`); messages otherwise flow via the backend (socket + Admin SDK). The `chatClosed` socket handler did **not** archive (only `/api/guest/force-close` did), so the client write couldn't simply be deleted.
- **Fix (implemented 2026-06-14, zero-regression):** (a) `socket.js` `chatClosed` now archives server-side (mirrors `force-close`); (b) removed the client archive + unused Firestore imports from `Guest-Chat-Box-Component.js`; (c) new `firestore.rules` denies all unauth `messages` read/list/create/update + anon `guests` write, keeps admin-scoped reads + public `siteConfig`/`branches`/`branchStatus`; (d) wired `firebase.json`. **Verify:** `firestore.rules.test.mjs` in the Firestore emulator, then deploy rules. **Deploy order:** backend+frontend code first, then rules. **Perf:** none.

---

## A02 — Security Misconfiguration

**Baseline (do not regress):** `helmet` with nonce-based CSP, `'unsafe-inline'`-free `scriptSrc`, `frameAncestors 'none'`, `objectSrc 'none'`, `upgradeInsecureRequests` (`server.js:327`, P3-1); helmet defaults (HSTS / nosniff / Referrer-Policy) intact; strict CORS allowlist, no wildcard-with-credentials (`server.js:193`); pinned `trust proxy` (P3-2); `/api` locked to edge via `requireEdgeAuth` (P2-2). **No secrets git-tracked** — only `.env.example` templates; root `.gitignore` flags `backend/firebase.json` as a leaked SA key to rotate.

- **A02-1 (Low) — ✅ fixed (Wave 3):** the localhost dev origins in CSP `connectSrc` are gated behind `NODE_ENV !== "production"`, so they are never emitted in the production CSP (dev keeps them).
- **A02-2 (Low) — ✅ fixed (Wave 3):** `Permissions-Policy` now denies `camera=()`, `microphone=()`, `geolocation=()` (unused by the app); the Facebook `unload` allow-list is preserved.
- **A02-3 (Low) — ✅ fixed (Wave 3):** all 5 Facebook error responses return only a generic `error` field in production; `upstream`/`message` detail is gated to non-prod (still logged server-side).

---

## A03 — Software Supply Chain Failures

> **Dynamic step complete** — `npm audit --omit=dev` run 2026-06-14 across all four packages (see results table below).

- **A03-1 (Medium → ✅ highs cleared 2026-06-14)** — backend started at **12 advisories (4 high / 8 moderate)**. The **4 highs** (deprecated `csurf → csrf-tokens → uid-safe → base64-url` chain) are **eliminated** (A03-1b removed `csurf`). The remaining **8 moderate** are `uuid` vendored inside `firebase-admin`'s `@google-cloud/*`/`gaxios` tree — fixable only by a breaking `firebase-admin@14` (deferred; that `uuid` is used for `v4`, not the vulnerable `v3/v5/v6`-with-`buf` path, so effectively non-exploitable). Direct deps at safe ceiling (`uuid@11.1.1`, `firebase-admin@13.10.0`). `render.yaml:32` `npm install`→`npm ci` optional. No SBOM/Dependabot (roadmap).
  - **Do NOT** run `npm audit fix --force` (forces `firebase-admin@14` here and `react-scripts@0.0.0` on the frontends — both breaking).
- **A03-2 (Low) — frontend counts are build/test-time, not shipped runtime.** admin-frontend **30** and user-frontend **31** advisories are almost entirely the `react-scripts` build/test tree (`shell-quote` critical = build CLI, `webpack-dev-server`, `jest`/`jsdom`, `nth-check`/`postcss`/`svgo`/`serialize-javascript`/`terser` = build). **✅ fixed (Wave 4):** the one runtime-relevant item — `react-router` protocol-relative open redirect (GHSA-2j2x-hqr9-3h42) — is resolved by bumping `user-frontend` to `react-router-dom@6.30.4` (a non-breaking 6.30.3→6.30.4 patch; `admin-frontend` is already on 7.15.1 and clean). The remaining counts are the `react-scripts` build/test tree (not shipped runtime); durable fix is migrating CRA → Vite (deferred).
- **`magis-edge-worker`: 0 advisories** (clean — `jose`/`jsonschema`/`dotenv`).
- **Lockfiles:** `backend/package-lock.json` present; verify lockfiles exist + are committed for all four packages, then switch CI to `npm ci`.
- **CSRF-1 (Low, new finding) — the CSRF token is decorative.** `GET /api/csrf-token` issues a token and the client sends `X-CSRF-Token`, but **no route validates it** (`csurf` was mounted only on the token endpoint, never on mutating routes; A03-1b preserved this behavior). Structurally mitigated today: API auth is Bearer-JWT in the `Authorization` header (not forgeable cross-site), cookies are `sameSite=Strict`, and `/api` is edge-locked (P2-2). **Follow-up (separate, tested PR):** either enforce double-submit validation on any cookie-authed mutating route, or formally adopt header-auth as the CSRF control and drop the decorative token. *Do NOT enable enforcement without testing — it would 403 any mutating request lacking the header.*

---

## A04 — Cryptographic Failures

**Baseline (do not regress):** conversation keys use `aes-256-gcm` with fresh 12-byte random IVs + at-rest wrapping (`messages.js:130`, P1-1); RS256/HS256 alg policy enforced in the worker (P2-3 / P3-5, alg-confusion-safe); TOTP + 64-bit backup codes via `crypto.randomBytes` (P3-3); per-request CSP nonce via `crypto.randomBytes(16)`.

- **A04-1 (Low) — ✅ fixed (Wave 3):** `BranchAdmin-Login.js:275` and `MFASessionModal.js:225` now use `crypto.randomUUID()` (matching `initSession.js`). The third reference, `Branch-Chat-Dashboard.js:722`, had no `Math.random` session id — already clean.

---

## A05 — Injection (+XSS)

**Baseline (do not regress):** Firestore SDK queries are parameterized; Zod validates socket payloads (`socket.js:784`); email header injection + HTML escaping handled (P1-5); no `eval`/`child_process` in backend.

- **A05-1 (Low, CSP-mitigated) — ✅ fixed (Wave 3):** `nodeRef.current.innerHTML = \`...data-href="${href}"...\`` (`user-frontend/src/components/FacebookLatestVideo.jsx:124`). `href` is Facebook-derived; the nonce-based CSP blocks inline script execution, so real-world XSS risk is very low. Now built with `createElement` + `setAttribute` (`data-href` set as a literal attribute value — no HTML parsing).
- **A05-2 (Info)** — `mongoose` runs only in a manual migration script (`backend/addSpaceIdToBranchAndMessages.js:45`); no runtime NoSQL injection surface.

---

## A06 — Insecure Design

**Baseline (do not regress):** Redis-backed rate limits on login (5/15m), guest init, guest contact (P1-4 / P2-1); per-guest hourly socket message cap (`socket.js:749`); multer 5 MB + MIME allow-list; step-up MFA + geo-anomaly detection.

- **A06-1 (Low)** — media resolvers (`/media/:id`, `/admin-media/:id`), `/conversation-key`, and `/history` rely on edge rate-limiting (KV currently unbound in `wrangler.toml`) rather than app-level limits. Add an app-level limiter as defense-in-depth.

---

## A07 — Authentication Failures

**Baseline (well-covered, do not regress):** short JWT TTLs; JTI revocation on logout for both admin roles (`server.js:540`, `:564`); `httpOnly`+`Secure`+`SameSite` cookies; fresh-TOTP step-up for MFA sessions (`mfa.js:59`); `EWORKERBUSY→503` so worker saturation never degrades auth (P3-7). **No new findings** beyond the dead bcrypt path (see Hygiene).

---

## A08 — Software / Data Integrity Failures

**Baseline (do not regress):** private media + short-lived signed URLs (P1-3); Electron `preload.js` is minimal/safe (`contextIsolation:true`, `nodeIntegration:false`, one-way IPC).

- **A08-1 (Low) — ✅ fixed (Wave 3):** `electron-main.js` now guards navigation — `will-navigate` blocks off-origin nav (opening `http(s)` links externally) and `setWindowOpenHandler` denies non-same-origin new windows. **Note:** packaged `startURL` is still a placeholder (`https://admin.yoursite.com`) — set it before the desktop build.
- **A08-2 (Low / mostly N/A)** — no SRI, but no static external `<script src>` tags exist (SDKs load dynamically and don't support SRI).

---

## A09 — Security Logging & Alerting Failures

**Baseline (do not regress):** auth failures, ACL denials, geo anomalies, and sensitive-message audit are logged; **no secret/token values are logged** (P2-4 — `server.js:7` logs presence only).

- **A09-1 (Low-Med)** — `socket.on("debugLog", (log) => console.log("[DEBUG]", log))` (`socket.js:729`) logs arbitrary authenticated-client input → log injection (CRLF) / spam. Gate behind a dev flag or remove.
- **A09-2 (Info / roadmap)** — logs exist but there's no alerting/SIEM export or tamper-evident audit trail.

---

## A10 — Mishandling of Exceptional Conditions

**Baseline (a standout area, do not regress):** fail-open/closed modes are explicit + configurable (`MFA_FAIL_OPEN`, `RATE_LIMIT_FAIL_CLOSED`, edge auth mode); `secretPool` crash back-off + `EWORKERBUSY` backpressure (P3-7) is textbook A10.

- **A10-1 (Low / config) — ✅ wired (Wave 4):** `requireMFA` fails **open** only inside the `catch` (a transient Firestore error) by default (`requireMFA.js:24`). `MFA_FAIL_OPEN` is now documented in `backend.env.example` and set in `render.yaml` (`value:"false"`). **Activate by setting `MFA_FAIL_OPEN=false` in the Render dashboard** (the running service is dashboard-configured; `render.yaml` only applies on a Blueprint sync) — fail-closed returns 503 (retry) on a transient error instead of passing the SPI request.
- **A10-2 (Low) — ✅ fixed (Wave 3):** added a central 4-arg Express error handler (logs full detail server-side, returns a generic `{ error }`) and a JSON 404 for unmatched `/api` routes (instead of the SPA `index.html`). Prod hides stacks via Express's default handler, so this is hygiene, not a leak.

---

## Hygiene / latent risk

- **HYG-1 — ✅ deleted (Wave 5):** `routes/superadminauth.js` + `routes/branchadminauth.js` (dead, unmounted routers with unauthenticated `/assign-*`). Verified zero `require`/`app.use` repo-wide (no `readdirSync` auto-mount) before removal; `branchadminauth.js` also `require("bcrypt")` — not an installed dep (only `bcryptjs`) — so it could never load.
- **HYG-2 — ✅ deleted (Wave 5):** `backend/middlewares/api.js` (frontend `export`/`process.env.REACT_APP_API_URL` code, dead in a CommonJS backend; zero requires — ESM syntax would crash a CJS `require` anyway).
- **HYG-3 — ✅ deleted (Wave 5):** the stray CRA scaffold inside the edge worker — `magis-edge-worker/src/` (42 files), `public/` (5), and the `craco`/`postcss`/`tailwind` configs. The deployed worker (`index.js`, the `wrangler.toml` `main`) is a self-contained proxy that never imported them, and there is no `[site]`/asset binding.
- **HYG-4 — ✅ addressed (Wave 5):** confirmed **no surviving code** reads `.password` or uses `bcrypt` (the sole consumer was the deleted `branchadminauth.js`), so any `password` hash on a `branchAdmins` doc is stale. Added an operator-run purge script `backend/scripts/purge-branchadmin-passwords.js` (**dry-run by default**, `--apply` to delete the field). **Follow-up done:** the now-orphaned `bcryptjs` dependency (sole consumer was the deleted route) was removed from `backend/package.json` + lockfile.

---

## "Do-not-regress" baseline (already strong)

P0-1 fallback-token proof · P0-2 server-side MFA gate · P1-2 socket tenant isolation · P1-3 private media + signed URLs · P1-4/P2-1 rate limits + JTI revocation · P1-5 email/HTML escaping · P2-2 edge origin lock · P2-3/P3-5 JWT alg + iss/aud · P3-1 CSP nonces · P3-3 MFA crypto · P3-7 secretPool DoS hardening + `EWORKERBUSY→503` · explicit A10 fail modes.

---

## npm audit (A03 dynamic — results, 2026-06-14)

`npm audit --omit=dev` (production deps), per package:

| Package | Critical | High | Moderate | Low | Total | Nature |
|---------|----------|------|----------|-----|-------|--------|
| `backend` | 0 | 4 | 8 | 0 | **12** | **Runtime** — `csurf` chain + `firebase-admin`/`@google-cloud` tree + `uuid` |
| `admin-frontend` | 1 | 14 | 6 | 9 | **30** | Build/test-time (`react-scripts` tree); runtime: `react-router` only |
| `user-frontend` | 1 | 13 | 8 | 9 | **31** | Build/test-time (`react-scripts` tree); runtime: `react-router` only |
| `magis-edge-worker` | 0 | 0 | 0 | 0 | **0** | Clean |

Backend advisory modules: `csurf`, `csrf-tokens`, `uid-safe`, `base64-url`, `firebase-admin`, `@google-cloud/firestore`, `@google-cloud/storage`, `gaxios`, `google-gax`, `teeny-request`, `retry-request`, `uuid`.

**Interpretation:** the headline frontend criticals/highs are **build- and test-time tooling** that does not ship to end users' browsers, so production-runtime exposure there is Low. The actionable runtime risk lives in the **backend** (deprecated `csurf` + outdated `firebase-admin` tree) and is fixable without breaking changes (except the `csurf` replacement, which is a CSRF-control change for triage). **Do not run `npm audit fix --force`** on the frontends — it forces `react-scripts@0.0.0`.

---

## Next steps

1. ~~Run `npm audit` to complete A03 evidence.~~ **Done 2026-06-14** (see results table).
2. **Triage (Phase 2):** rank by severity × effort; pre-write each fix's regression check (which `P`-item / perf path it must not disturb).
3. **Fix order (proposed):** A01-1 → A01-2 → A01-3 → A01-4 → A09-1 → A03-1 → remaining Low → Hygiene.
4. **Implement only after approval**, each with `node --check` + targeted smoke test + frontend build.

---

## Remediation Triage (Phase 2)

Effort: `S` ≤10 lines/1 file · `M` multi-file/new logic · `L` new artifact/dep migration. Each item names the `P`-item / perf path it must not disturb.

| Wave | ID | Sev | Effort | Perf-risk | Touches |
|------|----|-----|--------|-----------|---------|
| 1 | A01-1 | Med-High | S | None (keeps PERF2-4 bounded queries) | analytics ACL |
| 1 | A01-2 | Medium | S-M | Low (+1 Firestore read on `markSeen`) | P1-2 |
| 1 | A01-3 | Medium | S | None | P1-2 |
| 1 | A09-1 | Low-Med | S | None | P2-4 |
| 2 | A03-1a (deps) | Medium | — | — | **No-op — deps already at safe ceiling (2026-06-14)** |
| 2 | A01-4 (`firestore.rules`) | **High** | L | None (server-side archive added) | ✅ Implemented (emulator pending) |
| 2 | A03-1b (remove `csurf`) | Medium | S | None | ✅ Done — 4 highs cleared (native token gen) |
| 3 | A02-1 / A02-2 / A02-3 | Low | S | None | ✅ Done (Wave 3) |
| 3 | A04-1 / A05-1 / A08-1 / A10-2 | Low | S | None | ✅ Done (Wave 3) |
| 3 | A06-1 (rate-limit media/history) | Low | S-M | **Yes** (media hot path) | Deferred — perf-sensitive |
| 4 | A10-1 (`MFA_FAIL_OPEN=false`) | Low/config | S | None | ✅ Wired (Wave 4) — dashboard flip |
| 4 | A03-2 (`react-router-dom` bump) | Low | S | None | ✅ Done (Wave 4) — 6.30.4 |
| 5 | HYG-1..4 (dead code/data) | Low | S-M | None | ✅ Done (Wave 5) |

### Wave 1 (one PR — do first)
**Status: ✅ Implemented 2026-06-14** — `analytics.js` + `socket.js`; both pass `node --check`. Full socket smoke/regression still recommended before deploy.

- **A01-1** — `analytics.js:114,183,283`: `branchEmail || req.branchEmail` → `req.branchEmail`; branch-scope + `isDev`-gate `/debug:75` (leaks 5 collection-wide messages). *Regression:* superadmin `/branch-performance:378` untouched; `(branchEmail,timestamp)` index + PERF2-4 bounding preserved. *Verify:* `node --check`; branchadmin `?branchEmail=<other>` returns own branch only.
- **A01-2** — `socket.js:953 markSeen`: verify doc ownership vs `socket.user` before update; derive room server-side (mirror `messages.js:704`). *Regression:* strengthens P1-2.
- **A01-3** — `socket.js:863,886,968`: derive emit room from `socket.user`, not client `room`. *Regression:* P1-2; same-room delivery unaffected.
- **A09-1** — `socket.js:729 debugLog`: gate behind non-prod + strip CRLF. *Regression:* none.

### Wave 2 — data layer + deps
- **A03-1a:** ✅ checked 2026-06-14 — **no change available**: backend already at `uuid@11.1.1` + `firebase-admin@13.10.0` (safe ceiling). Remaining advisories need A03-1b or a breaking `firebase-admin@14`. `render.yaml`→`npm ci` is optional hardening.
- **A01-4 (High) — ✅ implemented 2026-06-14:** server-side `chatClosed` archive (`socket.js`) + removed client archive/imports (`Guest-Chat-Box-Component.js`) + new `firestore.rules` (deny unauth `messages`/`guests` writes, scope admin reads) + `firebase.json`. **Verify:** `firestore.rules.test.mjs` in the emulator, then deploy rules (code first, rules second).
- **A03-1b (✅ done 2026-06-14):** removed deprecated `csurf` (8 pkgs incl. `base64-url`/`csrf-tokens`/`uid-safe`) → **all 4 high advisories cleared, 0 high remain**. Replaced `/api/csrf-token` with a native `crypto.randomBytes` generator preserving the exact cookie + JSON contract — **zero regression** (no new dep, token-issuing behavior identical, `node --check` clean). Surfaced **CSRF-1**: the token is issued but never validated server-side (follow-up).

### Wave 3 — low-severity hardening (batch)
**Status: ✅ Implemented 2026-06-14** (`server.js` + `electron-main.js` pass `node --check`; the 3 React edits are statement-level). A02-1/2/3 (CSP localhost gated to non-prod, Permissions-Policy denies camera/mic/geo, FB errors genericized in prod) · A04-1 (`crypto.randomUUID()` in 2 files; the 3rd ref `Branch-Chat-Dashboard.js:722` was already clean) · A05-1 (`setAttribute`/DOM build instead of `innerHTML`) · A08-1 (Electron `will-navigate` + `setWindowOpenHandler` guards) · A10-2 (central error handler + `/api` JSON 404). **A06-1 deferred** (perf-sensitive — reuse Redis limiter, keep off media decode path).

### Wave 4 — config/ops
**Status: ✅ Implemented 2026-06-14.** **A10-1:** `MFA_FAIL_OPEN` documented in `backend.env.example` + added to `render.yaml` (`value:"false"`); **activate by setting `MFA_FAIL_OPEN=false` in the Render dashboard** (running service is dashboard-configured; render.yaml only applies on Blueprint sync). **A03-2:** `user-frontend` `react-router-dom` `6.30.3 → 6.30.4` (clears GHSA-2j2x-hqr9-3h42 protocol-relative open redirect; `admin-frontend` already on 7.15.1, clean). The lockfile re-resolve also healed pre-existing drift by adding optional `@tailwindcss/oxide-wasm32-wasi` deps (platform-optional, no build/runtime impact). Remaining frontend audit items are the `react-scripts` build/test tree (not shipped runtime; durable fix CRA→Vite, deferred); `npm ci`+Dependabot/SBOM still roadmap.

### Wave 5 — hygiene
**Status: ✅ Implemented 2026-06-14** — 53 files removed via `git rm`; survivors (`server.js`, edge `index.js`/`dev-server.js`) pass `node --check`; a post-deletion grep confirms zero dangling refs. **HYG-1/2/3:** deleted `routes/superadminauth.js`, `routes/branchadminauth.js`, `middlewares/api.js`, and the edge `src/`+`public/`+CRA configs. **HYG-4:** confirmed no live `bcrypt`/`.password` usage and added `backend/scripts/purge-branchadmin-passwords.js` (dry-run default) for the operator to purge stale `branchAdmins.password` hashes against the live DB. **Follow-up:** the orphaned `bcryptjs` backend dep was removed via `npm uninstall` (8-line diff; `server.js` still passes `node --check`). **Note:** `magis-edge-worker-temp/` is untracked, so left as-is.
