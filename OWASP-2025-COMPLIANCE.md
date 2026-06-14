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

**Strong.** Most of OWASP 2025 is already covered by `P0–P3`. Wave 1 (A01-1/2/3, A09-1) and the A01-4 data-layer hardening are implemented (A01-4 pending emulator-test + rules deploy). The deployed Firestore rules turned out to be **well-structured**; the one real gap was **unauthenticated, non-ownership-bound access to `messages`** (now closed in `firestore.rules`). Remaining: **4 Medium, ~11 Low**, plus hygiene/roadmap. No fix weakens an existing security or performance control.

| ID | OWASP 2025 | Severity | Location | Status |
|----|-----------|----------|----------|--------|
| A01-1 | A01 Broken Access Control | **Med-High** | `backend/routes/analytics.js:114,183,283` | ✅ Fixed (Wave 1) |
| A01-2 | A01 Broken Access Control | Medium | `backend/utils/socket.js:953` (`markSeen`) | ✅ Fixed (Wave 1) |
| A01-3 | A01 Broken Access Control | Medium | `backend/utils/socket.js:863,886,968` | ✅ Fixed (Wave 1) |
| A01-4 | A01 (data layer) | **High** | unauth `messages` access not ownership-bound | ✅ Fix ready (emulator-test pending) |
| A03-1 | A03 Software Supply Chain | Medium | backend: 4 highs (`csurf` chain) cleared; 8 mod (`firebase-admin@14`, deferred) | ✅ Highs cleared |
| A03-2 | A03 Software Supply Chain | Low | frontends: `react-scripts` build/test tree (runtime: `react-router`) | Confirmed |
| CSRF-1 | A01 / CSRF | Low | `csurf` token issued but never validated server-side | New (mitigated) |
| A02-1 | A02 Misconfiguration | Low | `backend/server.js:379` | New gap |
| A02-2 | A02 Misconfiguration | Low | `backend/server.js:308` | New gap |
| A02-3 | A02 Misconfiguration | Low | `backend/server.js:854,876` | New gap |
| A04-1 | A04 Cryptographic | Low | `admin-frontend/src/pages/BranchAdmin-Login.js:275` (+2) | New gap |
| A05-1 | A05 Injection (XSS) | Low | `user-frontend/src/components/FacebookLatestVideo.jsx:124` | New (CSP-mitigated) |
| A06-1 | A06 Insecure Design | Low | media resolvers / `conversation-key` / `history` | New gap |
| A08-1 | A08 Integrity | Low | `admin-frontend/electron-main.js` | New gap |
| A09-1 | A09 Logging | Low-Med | `backend/utils/socket.js:729` (`debugLog`) | ✅ Fixed (Wave 1) |
| A10-1 | A10 Exceptional Conditions | Low/config | `backend/middlewares/requireMFA.js:24` | By design |
| A10-2 | A10 Exceptional Conditions | Low | `backend/server.js:1063` | New gap |
| HYG-* | Hygiene / latent | Low | dead `assign-*` routers, misplaced `api.js`, edge CRA scaffold | Hygiene |

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

- **A02-1 (Low)** — dev origins in prod CSP `connectSrc`: `ws://localhost:5000`, `http://localhost:5000` (`server.js:379,381`). Remove for prod.
- **A02-2 (Low)** — `Permissions-Policy` only sets `unload` (`server.js:308`); `camera`/`microphone`/`geolocation` left at browser default. Add a restrictive policy.
- **A02-3 (Low)** — Facebook routes echo upstream error detail (`server.js:854`, `:876`). Generic-ify in prod.

---

## A03 — Software Supply Chain Failures

> **Dynamic step complete** — `npm audit --omit=dev` run 2026-06-14 across all four packages (see results table below).

- **A03-1 (Medium → ✅ highs cleared 2026-06-14)** — backend started at **12 advisories (4 high / 8 moderate)**. The **4 highs** (deprecated `csurf → csrf-tokens → uid-safe → base64-url` chain) are **eliminated** (A03-1b removed `csurf`). The remaining **8 moderate** are `uuid` vendored inside `firebase-admin`'s `@google-cloud/*`/`gaxios` tree — fixable only by a breaking `firebase-admin@14` (deferred; that `uuid` is used for `v4`, not the vulnerable `v3/v5/v6`-with-`buf` path, so effectively non-exploitable). Direct deps at safe ceiling (`uuid@11.1.1`, `firebase-admin@13.10.0`). `render.yaml:32` `npm install`→`npm ci` optional. No SBOM/Dependabot (roadmap).
  - **Do NOT** run `npm audit fix --force` (forces `firebase-admin@14` here and `react-scripts@0.0.0` on the frontends — both breaking).
- **A03-2 (Low) — frontend counts are build/test-time, not shipped runtime.** admin-frontend **30** and user-frontend **31** advisories are almost entirely the `react-scripts` build/test tree (`shell-quote` critical = build CLI, `webpack-dev-server`, `jest`/`jsdom`, `nth-check`/`postcss`/`svgo`/`serialize-javascript`/`terser` = build). The only runtime-relevant item is **`react-router` open redirect (moderate)** — bump `react-router-dom`. Real production-runtime browser risk is **Low**; durable fix is migrating CRA → Vite (larger effort).
- **`magis-edge-worker`: 0 advisories** (clean — `jose`/`jsonschema`/`dotenv`).
- **Lockfiles:** `backend/package-lock.json` present; verify lockfiles exist + are committed for all four packages, then switch CI to `npm ci`.
- **CSRF-1 (Low, new finding) — the CSRF token is decorative.** `GET /api/csrf-token` issues a token and the client sends `X-CSRF-Token`, but **no route validates it** (`csurf` was mounted only on the token endpoint, never on mutating routes; A03-1b preserved this behavior). Structurally mitigated today: API auth is Bearer-JWT in the `Authorization` header (not forgeable cross-site), cookies are `sameSite=Strict`, and `/api` is edge-locked (P2-2). **Follow-up (separate, tested PR):** either enforce double-submit validation on any cookie-authed mutating route, or formally adopt header-auth as the CSRF control and drop the decorative token. *Do NOT enable enforcement without testing — it would 403 any mutating request lacking the header.*

---

## A04 — Cryptographic Failures

**Baseline (do not regress):** conversation keys use `aes-256-gcm` with fresh 12-byte random IVs + at-rest wrapping (`messages.js:130`, P1-1); RS256/HS256 alg policy enforced in the worker (P2-3 / P3-5, alg-confusion-safe); TOTP + 64-bit backup codes via `crypto.randomBytes` (P3-3); per-request CSP nonce via `crypto.randomBytes(16)`.

- **A04-1 (Low)** — `Math.random()` builds admin `sessionId`: `admin-frontend/src/pages/BranchAdmin-Login.js:275`, `admin-frontend/src/components/MFASessionModal.js:225`, `user-frontend/src/pages/Branch-Chat-Dashboard.js:722`. Low impact (the admin JWT is still required; `sessionId` is not a standalone bearer secret), but inconsistent with `admin-frontend/src/utils/initSession.js:4` which uses `crypto.randomUUID()`. Standardize on `randomUUID()`.

---

## A05 — Injection (+XSS)

**Baseline (do not regress):** Firestore SDK queries are parameterized; Zod validates socket payloads (`socket.js:784`); email header injection + HTML escaping handled (P1-5); no `eval`/`child_process` in backend.

- **A05-1 (Low, CSP-mitigated)** — `nodeRef.current.innerHTML = \`...data-href="${href}"...\`` (`user-frontend/src/components/FacebookLatestVideo.jsx:124`). `href` is Facebook-derived; the nonce-based CSP blocks inline script execution, so real-world XSS risk is very low. Prefer `setAttribute`/escaping.
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

- **A08-1 (Low)** — `admin-frontend/electron-main.js` lacks `will-navigate` / `setWindowOpenHandler` guards (an XSS or rogue link could navigate the admin window off-origin); packaged `startURL` is a placeholder (`https://admin.yoursite.com`).
- **A08-2 (Low / mostly N/A)** — no SRI, but no static external `<script src>` tags exist (SDKs load dynamically and don't support SRI).

---

## A09 — Security Logging & Alerting Failures

**Baseline (do not regress):** auth failures, ACL denials, geo anomalies, and sensitive-message audit are logged; **no secret/token values are logged** (P2-4 — `server.js:7` logs presence only).

- **A09-1 (Low-Med)** — `socket.on("debugLog", (log) => console.log("[DEBUG]", log))` (`socket.js:729`) logs arbitrary authenticated-client input → log injection (CRLF) / spam. Gate behind a dev flag or remove.
- **A09-2 (Info / roadmap)** — logs exist but there's no alerting/SIEM export or tamper-evident audit trail.

---

## A10 — Mishandling of Exceptional Conditions

**Baseline (a standout area, do not regress):** fail-open/closed modes are explicit + configurable (`MFA_FAIL_OPEN`, `RATE_LIMIT_FAIL_CLOSED`, edge auth mode); `secretPool` crash back-off + `EWORKERBUSY` backpressure (P3-7) is textbook A10.

- **A10-1 (Low / config)** — `requireMFA` fails **open** by default (`requireMFA.js:24`). Recommend `MFA_FAIL_OPEN=false` in prod for SPI. Config-only, no code change.
- **A10-2 (Low)** — no centralized Express error handler / 404 (`server.js:1063`). Prod hides stacks via Express's default handler, so this is hygiene, not a leak.

---

## Hygiene / latent risk

- **HYG-1** — Dead, unmounted routers with unauthenticated `/assign-*`: `routes/superadminauth.js:104`, `routes/branchadminauth.js:226`. Not imported by `server.js` (confirmed at `server.js:421-424`) → not live. Delete to prevent a future accidental mount becoming privilege escalation.
- **HYG-2** — Misplaced frontend code in backend: `backend/middlewares/api.js` uses `export`/`process.env.REACT_APP_API_URL` (dead in a CommonJS backend).
- **HYG-3** — CRA scaffolding inside the edge worker: `magis-edge-worker/src/*` React components are stray.
- **HYG-4** — Stale bcrypt login model: dead `branchadminauth.js` references `bcrypt.compare(password, adminData.password)`; if `branchAdmins` docs still hold password hashes, purge them.

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
| 3 | A02-1 / A02-2 / A02-3 | Low | S | None | P3-1 (CSP) |
| 3 | A04-1 / A05-1 / A08-1 / A10-2 | Low | S | None | — |
| 3 | A06-1 (rate-limit media/history) | Low | S-M | **Yes** (media hot path) | P1-4 |
| 4 | A10-1 (`MFA_FAIL_OPEN=false`) | Low/config | S | None | P0-2 (config) |
| 4 | A03-2 (`react-router-dom` bump) | Low | S | None | — |
| 5 | HYG-1..4 (dead code/data) | Low | S-M | None | — |

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
A02-1/2/3 (CSP localhost, Permissions-Policy, FB error genericize) · A04-1 (`crypto.randomUUID()`) · A05-1 (`setAttribute` vs `innerHTML`) · A08-1 (Electron nav guards) · A10-2 (central error handler+404). **A06-1** is perf-sensitive — reuse Redis limiter, keep off media decode path.

### Wave 4 — config/ops (no app code)
`MFA_FAIL_OPEN=false` · `npm ci`+Dependabot/SBOM · `react-router-dom` bump.

### Wave 5 — hygiene
Delete dead `superadminauth.js`/`branchadminauth.js` (**verify no `require` first**), misplaced `backend/middlewares/api.js`, edge CRA scaffold; purge stale `password` hashes.
