# Magis Pawnshop — Security Remediation Plan

**Status:** Draft for stakeholder review
**Scope:** `backend/` (Express + Firebase + Socket.IO), `magis-edge-worker/` (Cloudflare), `admin-frontend/`, `user-frontend/`
**Prepared by:** Engineering (security review)
**Last updated:** 2026-06-13

> This document is an assessment and action plan. **No application code has been changed** as a result of this review. File/line references point to the current `main` branch.

---

## 1. Executive summary (for management)

The platform already includes several above-average security features for a pawnshop: automatic redaction of Philippine government IDs in chat, multi-factor authentication (MFA) with location-anomaly detection, and encrypted messaging. These are real differentiators worth marketing.

However, the review found a small number of **high-impact gaps** that should be closed before they are marketed as strengths, because they touch directly on the **Data Privacy Act of 2012 (RA 10173)**, **BSP supervision of pawnshops**, and the **Financial Consumer Protection Act (RA 11765)**:

- A maintenance ("fallback") endpoint can issue an **administrator access token to anyone**, with no password.
- The **server does not actually enforce MFA** on the screens that show customer data — enforcement is currently only in the browser.
- Messaging is labelled **"end-to-end encrypted,"** but the encryption keys are generated and stored by our own server — so the claim is not technically accurate as written.
- **Customer-uploaded photos** (often IDs and pawned items) are stored as **publicly accessible files**.

None of the recommended fixes require removing features or degrading the customer experience. Most are small, backward-compatible changes. The plan below is sequenced so the highest legal/financial risk is addressed first.

**Headline risk:** items P0-1, P0-2, and P1-1 together could allow an outsider to read a branch's customer conversations and decrypt stored messages. Treat these as priority.

---

## 2. How to read this document

**Severity**

- **Critical** — exploitable now, exposes customer data or admin control.
- **High** — significant exposure; realistic attack path or clear legal gap.
- **Medium** — weakens defenses; depends on configuration or chaining.
- **Low / Hardening** — best-practice improvements and defense-in-depth.

**Priority**

- **P0** — start immediately.
- **P1** — within ~1 week.
- **P2** — within ~2-4 weeks.
- **P3** — strategic / roadmap.

**No-regression note** — every item includes how to ship it *without* breaking existing functionality.

---

## 3. Findings & remediation checklist

### CRITICAL

#### [x] P0-1 — Anyone can mint a Branch-Admin token (authentication bypass) — ✅ FIXED 2026-06-07
- **Severity:** Critical
- **Where:** `backend/server.js:414-464` (`/api/issue-fallback-token`); allow-listed as public at the edge in `magis-edge-worker/index.js:334`
- **Risk:** The endpoint issues a full `branchadmin` JWT given only a `branchEmail` — no password, no Firebase token, no MFA. Reachable from the public internet. Chains with P0-2 to read a branch's chat history and pull conversation/decryption keys.
- **PH legal driver:** DPA 2012 (technical safeguards, unauthorized access); BSP IT-risk (access control); RA 11765 (digital-channel security).
- **Remediation:** Require proof to mint a fallback token — e.g. a valid-but-recently-expired Firebase ID token, or a signed break-glass secret held only by operations — and keep the issued token short-lived + MFA-bound.
- **No-regression note:** The legitimate "Firebase is temporarily down" recovery path still works; it simply must present the session proof the admin client already holds.
- **Effort:** S
- **Resolution:** `/api/issue-fallback-token` is now a proof-required token *exchange* (`backend/server.js:413-555`). It accepts only (1) a valid Firebase ID token resolving to a branchadmin, or (2) rotation of an existing/recently-expired (≤ `FALLBACK_REFRESH_GRACE_MIN`, default 24h), non-revoked HMAC token. Identity is derived from the verified proof — the client-supplied `branchEmail` is no longer trusted (only checked for consistency). Client call sites now attach proof: `admin-frontend/src/pages/BranchAdmin-Login.js` (Firebase ID token at login), `admin-frontend/src/context/AuthContext.js` (Firebase token + prior HMAC token on refresh), `admin-frontend/src/components/Admin-Utils-socket.js` (both socket refresh paths). The edge allow-list entry stays (the edge cannot verify Firebase RS256 tokens; the backend now verifies). Verified: backend `node --check` OK; admin build OK.

#### [x] P0-2 — Server-side MFA is never enforced — ✅ FIXED 2026-06-07
- **Severity:** Critical
- **Where:** `backend/middlewares/requireMFA.js` exists but is **applied to zero routes** (verified by search). Sensitive endpoints rely only on `authenticateBranchAdmin`: `backend/routes/messages.js:606` (history), `:697`/`:719` (conversation-key), `:641` (`/all`).
- **Risk:** The MFA step-up and geo-lock logic in `backend/routes/mfa.js` is effectively **client-side only**. A token obtained without MFA (see P0-1) can read customer data.
- **PH legal driver:** DPA 2012 (access control on sensitive personal information); BSP IT-risk; RA 11765.
- **Remediation:** Apply `requireMFA` to the SPI-bearing routes and source `mfaVerified` from the existing `mfa_sessions` Firestore record.
- **No-regression note:** Admins who have completed TOTP already have a valid session document, so normal usage is unaffected.
- **Effort:** S-M
- **Resolution:** `requireMFA` (`backend/middlewares/requireMFA.js`) rewritten to validate an active `mfa_sessions` record (exact `${email}_${sessionId}` fast path when `X-Session-Id` is sent, else any active session for the email; honors 8h expiry + `geoLocked`; fails open on transient errors, `MFA_FAIL_OPEN=false` to fail closed). Applied after `authenticateBranchAdmin` to `/api/messages/history`, `/api/messages/conversation-key` (admin), `/api/guest/chat-logs`, `/api/guest/pending-inquiries`. Verified `node --check` OK. **Effective control:** the admin dashboard reads `messages` directly from Firestore but fetches the AES key via `conversation-key`, so gating that endpoint means E2EE content cannot be decrypted without MFA. `/api/messages/all` (superadmin) intentionally NOT gated (different token model; MFA enforced at superadmin login). **Caveat:** plaintext messages read directly from Firestore are not covered — see P1-6.

#### [ ] P0-3 — Live backend secrets committed to git (Firebase key + full .env bundle) — 🚨 NEW (CRITICAL)
- **Severity:** Critical
- **Where:** `backend/firebase.json` (real SA key, key id `0a1755be...`, SA `firebase-adminsdk-opl9i@magis-website.iam.gserviceaccount.com`) AND `backend/backend.zip` — a stale build artifact that bundled the **entire backend secret set**: `backend.env` (`JWT_SECRET`, `MONGO_URI`, Google OAuth `CLIENT_SECRET`/`REFRESH_TOKEN`, `GOOGLE_API_KEY`, `SMTP_PASS`/`SUPPORT_EMAIL_PASSWORD`, `FB_PAGE_ACCESS_TOKEN`, `FIREBASE_PRIVATE_KEY`) plus `.env.staging/.production/.development` (`REDIS_URL`). Tracked since `887fbb2`, pushed to `github.com/jmreyes777/magis-website`.
- **Risk:** Total compromise. `JWT_SECRET` lets an attacker forge ANY admin/superadmin token, which fully defeats P0-1 and P0-2. `MONGO_URI` = full DB access. Firebase key = full project admin (Firestore/Auth/Storage). OAuth/SMTP/API tokens = account & service takeover.
- **PH legal driver:** DPA 2012 (security of processing; reportable personal-data breach if exploited); BSP IT-risk; RA 11765.
- **Remediation:** (1) PURGE from git history + force-push; (2) ROTATE every exposed secret — `JWT_SECRET` first (invalidates sessions), then Firebase key, `MONGO_URI`, OAuth client secret + refresh token, SMTP/email passwords, `GOOGLE_API_KEY`, `FB_PAGE_ACCESS_TOKEN`, and `REDIS_URL` if it embeds a password.
- **Status:** Untracked + ignored 2026-06-07. **History PURGED 2026-06-07** (git filter-branch over all 35 commits + `--force-with-lease` push + backup/refs-original removal + reflog expire + `gc --prune=now`; verified no ref or object references the paths). ⚠️ **SECRET ROTATION still required (owner action)** — and GitHub can cache old commits by SHA until its own GC, so rotation is the only definitive fix.
- **Follow-up TODO (maps key):** `REACT_APP_GOOGLE_MAPS_API_KEY` (…5fQucE) is public-by-design (baked into the built frontend bundle), distinct from the now-deleted backend `GOOGLE_API_KEY` (…SSsaYo). Lock it down via **API restrictions** (Maps JavaScript API + Maps Static API) + a billing/quota cap now; **⬜ add Application restrictions → HTTP referrers (websites) once the production domain exists.**
- **Effort:** S (rotation per secret) + M (history rewrite — done)

### HIGH

#### [x] P1-1 — "End-to-end encrypted" is server-escrowed encryption — ✅ ADDRESSED 2026-06-07
- **Severity:** High
- **Where:** Key generated/stored/served by backend: `backend/routes/messages.js:113-133`, `:697-736`; client imports server key in `user-frontend/src/utils/e2eeCrypto.js:226-242`. At-rest wrapping is **disabled unless `CONV_KEY_SECRET` is set** (`backend/routes/messages.js:75-84`), and that variable is **absent from `backend/backend.env.example`**. UI claims true E2EE.
- **Risk:** A database/admin compromise can decrypt all messages. Marketing/labeling the channel as E2EE while the server holds keys is a **transparency/representation** issue.
- **PH legal driver:** DPA 2012 (transparency, security measures); RA 11765 + DTI (no misleading representations to consumers).
- **Remediation (choose):** (a) Re-label to "encrypted in transit and at rest" and move key custody to a managed KMS/HSM; or (b) restore genuinely client-held keys. **Immediately:** set `CONV_KEY_SECRET` so stored keys are wrapped.
- **No-regression note:** Messaging behaviour is unchanged under either option.
- **Effort:** S (set secret) / M-L (KMS or true E2EE)
- **Resolution:** Decision = keep the server-managed-key model and correct the claim (option a, label). (1) **Label fixed** — removed the false "End-to-end encrypted" claim — admin badge → "Encrypted (AES-256-GCM)" (`admin-frontend/src/pages/Branch-Chat-Dashboard.js:2776`); guest badge → "Your messages are encrypted" with the cipher detail in a hover tooltip (`user-frontend/src/components/Guest-Chat-Box-Component.js:2121`); "failed/connecting" states unchanged. (2) **At-rest key wrapping** — `CONV_KEY_SECRET` documented in `backend/backend.env.example` (was absent); value generated, **must be set in Render** (owner action). Backward-compatible: `unwrapConversationKey` returns non-`v1:` values as-is, so existing raw keys keep working and new keys are written wrapped (`v1:`) — no migration/outage. **Scope:** this is encryption-at-rest for the key material (defends a Firestore/backup-only leak), NOT true E2EE; full client-held E2EE / KMS custody deferred (roadmap). **Pending owner action:** set `CONV_KEY_SECRET` in Render + rebuild/redeploy both frontends to ship the label.

#### [x] P1-2 — Cross-branch live message leak via socket `joinRoom` — ✅ FIXED 2026-06-07
- **Severity:** High
- **Where:** `backend/utils/socket.js:488-494` joins `admin-<client-supplied-room>` with no check that the room is the admin's own branch.
- **Risk:** A branch-A admin can subscribe to branch-B's live conversations (tenant isolation break / IDOR).
- **PH legal driver:** DPA 2012 (unauthorized access / data segregation).
- **Remediation:** Ignore the client-supplied room for admins; bind strictly to `socket.user.email`.
- **No-regression note:** Admins already auto-join the correct branch room at connection time (`backend/utils/socket.js:386-398`), so legitimate behaviour is unchanged.
- **Effort:** S
- **Resolution:** `joinRoom` (`backend/utils/socket.js:488-517`) no longer trusts the client-supplied `roomName`. The joined room is derived strictly from the verified token identity — admins → `admin-<socket.user.branchEmail||email>`, guests → `guest-<socket.user.guestId>` — so an admin can no longer subscribe to another branch's room (nor a guest to another guest's). A mismatch between the requested and bound room is logged (`🚫 joinRoom denied`) for anomaly detection. **No-regression verified:** every frontend caller already passes its own room (admin `admin-${branchEmail}` from session — `Admin-Utils-socket.js:310,502,577,846`, `Utils-socket.js:188`; guest `guestRoom` — `Guest-Chat-Box-Component.js:1334`, `User-Utils-socket.js:405,546`). All other `socket.join()` sites (`:390`, `:397`) were already token-derived. `node --check` OK.

#### [x] P1-3 — Customer-uploaded media is world-public — ✅ FIXED 2026-06-07
- **Severity:** High
- **Where:** `backend/utils/firebase.js:129` and `backend/routes/messages.js:42` call `file.makePublic()` on every upload.
- **Risk:** Photos of IDs, pawned items, and receipts become permanent public URLs accessible without authentication.
- **PH legal driver:** DPA 2012 (sensitive personal information must be access-controlled); AMLA (KYC record protection).
- **Remediation:** Keep objects private; serve through short-lived signed URLs scoped to the conversation participants.
- **No-regression note:** The chat UI receives a signed URL instead of a public one; images still display.
- **Effort:** M
- **Resolution:** Chat media is now stored PRIVATE and served via short-lived (~15-min) V4 signed URLs scoped to the participant. **Backend** (`backend/routes/messages.js`): `uploadMediaToStorage` no longer calls `makePublic()` and returns the storage path; guest + admin uploads store `media.path`; added `signMediaPath`/`signMessageMedia` + two resolver endpoints — `GET /api/messages/media/:id` (guest, scoped to own `guestId`) and `GET /api/messages/admin-media/:id` (`authenticateBranchAdmin` + `requireMFA`, scoped to own branch). **Frontends**: `mediaResolver.js` helpers (guest + admin) + both live renderers (`admin-frontend/src/components/Admin-Message-Item-Component.js`, `user-frontend/src/Shared/Message-Item-Component.js`) resolve `media.path` → signed URL on display (cached; legacy `http(s)` + optimistic `blob:`/`data:` pass through; "Loading attachment…" placeholder). **Scope decision:** branch storefront pictures (`firebase.js:uploadToStorage` → `branches.js`) intentionally stay PUBLIC — marketing assets shown to anonymous users on the public branches page (not customer SPI); signing cannot protect a public page. **Migration (Option 2):** `backend/scripts/migrate-media-private.js` (dry-run default, `--apply`) backfills `media.path` from existing public URLs, `makePrivate()`s the objects, and drops the public `url`/`src`/`srcSet`. **Verified:** backend `node --check` OK; admin + user builds compile. **Owner actions:** run the migration once with `--apply`, then redeploy all three services. **✅ Completed in staging 2026-06-07:** all 3 services deployed on `3d44275`; migration applied against bucket `magis-website.firebasestorage.app` (scanned=3190, migrated=62, skipped=3128, errors=0).

#### [x] P1-4 — Guest tokens mintable/refreshable without proof; predictable IDs; no server-side CAPTCHA — ✅ FIXED 2026-06-07
- **Severity:** High
- **Where:** `backend/routes/guest.js:81-128` (`/init`), `:317-359` (`/refresh-token`); IDs formed as `guest-<timestamp>` (`guest.js:90`); only `REACT_APP_RECAPTCHA_SITE_KEY` exists (no server-side verify — confirmed by search).
- **Risk:** Anyone can mint/refresh guest sessions for arbitrary IDs; enumerable IDs enable targeting; no real bot protection on public endpoints.
- **PH legal driver:** DPA 2012 (integrity/abuse); RA 11765 (channel integrity).
- **Remediation:** Random UUID guest IDs; verify reCAPTCHA/Cloudflare Turnstile server-side on `/init`; require the prior token on refresh.
- **No-regression note:** Token contents/flow unchanged for legitimate guests.
- **Effort:** M
- **Resolution (A + C done 2026-06-07; B pending):** **(A) Unguessable IDs** — `/init` now mints `guest-<uuid>` instead of `guest-${Date.now()}` (`backend/routes/guest.js`). **(C) Proof-required refresh** — `/refresh-token` now requires a guest token we previously issued, read from the `guestToken` cookie, an `Authorization: Bearer` header, or `body.token`; it is verified with `jwt.verify` (`ignoreExpiration` bounded by `GUEST_REFRESH_GRACE_MS`, default 30d) and must be `role:'user'`. The new token is minted strictly for the identity inside the verified token — client-supplied `guestId`/`branchEmail` are ignored. All five frontend refresh call sites (`utils/tokenManager.js`, `utils/api.js`, `Shared/User-Utils-socket.js` ×2, `components/Guest-Chat-Box-Component.js` ×2) also send the prior token as `Bearer`, so refresh still works if cross-site cookies are blocked; user build compiles. **(B) Server-side CAPTCHA on `/init` — PENDING provider choice:** the guest site has no CAPTCHA widget today, so this needs either reCAPTCHA v3 (reuse the admin site key + a new backend secret) or Cloudflare Turnstile, plus frontend wiring + an owner-set secret. Backend will enforce only when the secret is configured (graceful). **Interim mitigation shipped 2026-06-07:** a per-IP rate-limit now guards `/api/guest/init` (`backend/server.js`, Redis-backed, prefix `rl:guest-init:`; tunable via `GUEST_INIT_RL_MAX`/`GUEST_INIT_RL_WINDOW_MS`, default 20 per 10 min). **Provider chosen: Cloudflare Turnstile** (privacy-aligned with DPA, native to the CF edge) — **WIRED 2026-06-07:** an invisible widget (`user-frontend/src/Shared/turnstile.js`) attaches a token to both `/init` callers (`pages/Branches-List-User-Page.js`, `Shared/User-Utils-socket.js`); backend `verifyTurnstile` (`backend/routes/guest.js`) checks it on `/init`, **enforced once `TURNSTILE_SECRET` is set** (graceful no-op otherwise; fail-OPEN on Cloudflare-verifier outage). Public site key embedded with an env override (`REACT_APP_TURNSTILE_SITE_KEY`). Backend `node --check` OK; guest build compiles. **Owner action:** set `TURNSTILE_SECRET` in Render `magis-website` *after* the guest frontend redeploys (users on a cached old bundle must refresh once enforcement is on).

#### [x] P1-5 — Open email relay / spam via contact endpoint — ✅ FIXED 2026-06-07
- **Severity:** High
- **Where:** `backend/routes/guest.js` (`/contact`) was unauthenticated, emailed attacker-controlled `to: [branchEmail, guestEmail]` with attachments via the support Gmail; HTML body built by string interpolation.
- **Risk:** Abuse to send arbitrary email from your domain (blacklist/reputation damage), HTML injection.
- **PH legal driver:** RA 11765 (consumer-facing channel integrity); anti-spam good practice.
- **Remediation:** Turnstile-gate or authenticate; restrict recipient to the resolved branch address; encode/sanitize the body; rate-limit.
- **Status:** Done. `/contact` now requires a valid guest session (`authenticateGuest`); recipient is resolved **server-side** from a verified branch (`branchAdmins` lookup + `resolveBranchStaffEmail`) — unknown branch → 404; the guest email is demoted to `replyTo` (never a recipient), closing the open relay; the guest email is CR/LF-stripped + format-validated (no header injection) and HTML-escaped in the body (no HTML injection); message length capped at 5000; per-IP rate-limit (`GUEST_CONTACT_RL_MAX`, default 5 / 10 min) added in `server.js`. Frontend `TranscriptModal.js` attaches a Bearer guest-token proof. **Dead-route cleanup (2026-06-07):** removed `POST /pending-inquiry` (was dead + unauthenticated — an open Firestore-write vector into `pendingInquiries`) and `POST /send-chat-log` (dead; zero callers). **Admin-side retirement (2026-06-07):** with both guest-side writers gone, the reader endpoints were also removed — `GET /chat-logs`, `POST /reply-transcript`, `GET /pending-inquiries`, `PATCH /pending-inquiries/:id/read` — along with their now-unused `authenticateBranchAdmin`/`requireMFA` imports, and the corresponding dead UI in `admin-frontend/src/pages/Branch-Chat-Dashboard.js` (the `false &&`-gated transcript viewer + transcript/inquiry state, handlers, and fetch effects). The live "Active Chats" view is untouched. Both frontends build clean.
- **Effort:** S-M

#### [ ] P1-6 — Admin reads plaintext messages directly from Firestore (rules-dependent) — 🚨 NEW
- **Severity:** High
- **Where:** `admin-frontend/src/pages/Branch-Chat-Dashboard.js:1022,1215,1337,1822` read the `messages` collection via the Firebase client SDK (`getDocs`), bypassing the backend API. No `firestore.rules` file exists in the repo (rules live in the Firebase console; unverified).
- **Risk:** P0-2 protects the backend API + the conversation-key (so E2EE content needs MFA to decrypt), but NON-E2EE/plaintext message bodies read straight from Firestore are governed only by Firestore Security Rules.
- **PH legal driver:** DPA 2012 (access control on SPI at the data layer).
- **Remediation:** Author `firestore.rules` enforcing branch-scoped reads (and, where feasible, an MFA-session check via `get()`), commit them to the repo, deploy. Verify against the admin's existing direct reads + guest writes before rollout.
- **Effort:** M

### MEDIUM

#### [ ] P2-1 — Rate limiting and token revocation are likely inert in production
- **Severity:** Medium
- **Where:** Redis defaults to localhost (`backend/utils/redis.js:24-27`); backend silently swallows Redis errors (`backend/server.js:44-53`); edge KV unbound → fail-open (`magis-edge-worker/index.js:184-198`, `magis-edge-worker/wrangler.toml:26-29`); in-memory revocation only when `REDIS_URL` unset (`backend/workers/secretWorker.js:21-44,165-173`).
- **Risk:** Login brute-force protection and logout/force-close **revocation** may not function across instances/restarts.
- **PH legal driver:** BSP IT-risk; DPA 2012 (session management).
- **Remediation:** Provision managed Redis (`REDIS_URL`) and bind the edge KV namespace.
- **Resolution (code hardening done 2026-06-07; infra PENDING operator):** The original risk was that this control is *silently* inert. Code now makes it impossible to be silent and adds opt-in strict modes: **(1) Observability** — `backend/server.js` no longer swallows Redis errors (throttled explicit "DEGRADED" warning) and runs a startup self-check that logs a loud banner in prod/staging when `REDIS_URL` is missing; `redis.js` exports `isRedisConfigured()`. **(2) Hard-fail (opt-in)** — `REQUIRE_REDIS=true` makes the server refuse to start in prod without Redis (default off). **(3) Fail-closed revocation (opt-in)** — `backend/workers/secretWorker.js` adds `JWT_REVOCATION_FAIL_CLOSED=true` to reject a token when the Redis revocation check is unknown (default off = legacy fail-open; logs the active mode at boot). **(4) Edge** — `maybeRateLimit` now `typeof`-guards the KV binding and supports `RATE_LIMIT_FAIL_CLOSED="true"` to block on KV errors (default fail-open). Env/config documented in `backend.env.example` + `wrangler.toml`. **Still required (infra, only the operator can do):** provision managed/HA Redis and set `REDIS_URL` (then optionally `REQUIRE_REDIS=true`, `JWT_REVOCATION_FAIL_CLOSED=true`); create + bind `RATE_LIMIT_KV` (`wrangler kv namespace create RATE_LIMIT_KV` → uncomment binding → `wrangler deploy`).
- **Effort:** S (infra)

#### [ ] P2-2 — Origin is not locked to the edge
- **Severity:** Medium
- **Where:** Backend directly reachable (`magis-edge-worker/wrangler.toml:20`); `EDGE_SHARED_SECRET` absent from env template → trust **fails open** (`backend/utils/geoSecurity.js:48-52`).
- **Risk:** Edge JWT/rate/geo controls are bypassable by hitting the origin directly; geo headers spoofable.
- **Remediation:** Set `EDGE_SHARED_SECRET` and reject non-edge traffic, or use Cloudflare Tunnel / mTLS origin authentication.
- **Resolution (code done 2026-06-07; infra PENDING operator):** The edge already injects `X-Edge-Auth: <EDGE_SHARED_SECRET>` on every `/api` request and strips client-supplied copies first (`magis-edge-worker/index.js` `withForwardedGeo`). The missing half — backend enforcement — is now in place: `backend/utils/geoSecurity.js` adds a `requireEdgeAuth` middleware mounted on `/api` in `server.js` (after CORS, before all `/api` routes). It is **rollout-safe**: no-op in non-prod, no-op when `EDGE_SHARED_SECRET` is unset, always allows `OPTIONS` preflight, and is scoped to `/api` so `/health` probes and `/socket.io` are unaffected. Mode is governed by `EDGE_AUTH_MODE`, defaulting to **`monitor`** (logs the offending `METHOD path + IP`, throttled, but allows) — deliberately NOT `enforce` by default, since a premature block (worker not yet sending the header) would 403 *all* API traffic. A startup log makes the posture explicit (`🔒 secret SET, mode=…` / `⚠️ DISABLED`). **Still required (infra/operator):** (1) `wrangler secret put EDGE_SHARED_SECRET` + redeploy the worker; (2) set the same `EDGE_SHARED_SECRET` on the backend with `EDGE_AUTH_MODE=monitor`; (3) confirm only `/health`/probes are flagged in logs; (4) flip `EDGE_AUTH_MODE=enforce`. (Defense-in-depth only; pairs with confirming whether the Render origin is reachable directly — see open question.) Socket.IO/WS origin-locking left out of scope to avoid handshake/upgrade risk (it has its own JWT handshake, P1-2).
- **Effort:** S-M

#### [ ] P2-3 — One symmetric JWT secret shared across edge and origin
- **Severity:** Medium
- **Where:** HS256 secret used in both Cloudflare (`magis-edge-worker/index.js:101,380-383`) and backend (`backend/workers/secretWorker.js:104,131`).
- **Risk:** Compromise of either system forges tokens for all roles.
- **Remediation:** Move to asymmetric signing (EdDSA/RS256): backend holds the private key; edge verifies with the public key only.
- **No-regression note:** Tokens remain JWTs; only the signing/verification keys change.
- **Resolution (code done 2026-06-07; key provisioning + cutover PENDING operator):** Added RS256 support with a **dual-algorithm transition**, gated by `JWT_ALG` defaulting to **`HS256`** so behavior is byte-for-byte identical until keys are provisioned. New `backend/utils/jwtKeys.js` centralizes signing/verify key+alg policy: `getSigningParams()` (RS256 private key when `JWT_ALG=RS256`, else HS256 secret), `getVerifyParamsForToken()` which selects the verify key from the token's declared alg **restricted to accepted algs** (never verifies RS256 with an HMAC secret nor vice-versa — closes the alg-confusion downgrade attack), and `verifyLocal()`. Signing is centralized in `secretWorker.js` (now uses the policy; keys forwarded via `secretPool` workerData) so all worker-backed verifies (`branchadminauth`, `authenticateGuest`, `authenticateSuperAdmin`, `socket.js`) are covered; the one direct verify (`routes/guest.js` refresh-proof) now uses `verifyLocal`. The **edge** `verifyJWT` verifies HS256 (secret) **or** RS256 (SPKI public key) by declared alg, **presence-gated** (drop `JWT_SECRET` from the worker post-cutover → HS256 auto-rejected). Operator tool: `node backend/scripts/generate-jwt-keypair.js`. Boot log shows the active sign alg + accepted verify algs. **RS256 sign→verify round-trip validated** (Node `jsonwebtoken` ↔ Web Crypto `RSASSA-PKCS1-v1_5`), HS256 path unchanged. **Still required (operator):** (1) generate keypair; (2) set `JWT_PRIVATE_KEY`+`JWT_PUBLIC_KEY` on backend, `JWT_PUBLIC_KEY` on the worker (redeploy); (3) set `JWT_ALG=RS256` (old HS256 tokens keep verifying via `JWT_ACCEPT_HS256=true`); (4) after ≥ admin TTL (~4h), set `JWT_ACCEPT_HS256=false` + remove `JWT_SECRET` from the edge. (Note: Firebase RS256 ID-token path is separate and untouched.)
- **Effort:** M

#### [ ] P2-4 — Secret hygiene
- **Severity:** Medium
- **Where:** `JWT_SECRET` prefix logged at boot (`backend/server.js:7,22`; `backend/utils/secretPool.js:26`; `backend/workers/secretWorker.js:13`); hardcoded dev fallback secret (`backend/utils/secretPool.js:25`); hardcoded superadmin email (`backend/server.js:319`); `backend/backend.zip` and `user-frontend/user-frontend.zip` are **not covered by `.gitignore`** and may bundle secrets; Cloudflare API token from earlier work still needs rotation.
- **Remediation:** Remove secret logging; delete the dev fallback constant; externalize the superadmin allowlist to config; delete/ignore the zip archives; rotate the Cloudflare token; consider a secrets manager.
- **Resolution (code done 2026-06-07; a few operator actions remain):** **(1) Secret logging removed** — `server.js` boot logs are now presence-only (`set`/`not set`, no prefix); `secretPool.js` no longer logs the secret length; `secretWorker.js` dropped the `JWT_SECRET`-prefix log **and** the `console.log("workerData", …)` dump (which after P2-3 would have leaked the **RSA private key**) — posture is reported by `jwtKeys.describe()` without key bytes. **(2) Dev fallback secret deleted** — `secretPool.js` no longer substitutes `"fallback-jwt-secret-key-for-testing-only-32chars!"`; if `JWT_SECRET` is required (HS256) but missing, signing now fails loudly instead of silently using a publicly-known constant. **(3) Superadmin allowlist externalized** — `server.js` reads `SUPERADMIN_EMAILS` (CSV) instead of the inline `jmreyes3167@gmail.com`; a legacy default + boot warning prevent owner lockout until the env is set; documented in `backend.env.example`. **(4) Zips** — verified **already** `.gitignore`d (`*.zip`, `**/*.zip`) **and never committed** (clean history), so there is no git exposure; the local files remain (operator may delete them — they are build artifacts). **Still required (operator):** rotate the Cloudflare API token; set `SUPERADMIN_EMAILS` in Render to silence the legacy-default warning; optionally delete the local zip archives; consider a managed secrets store. Note: the email also appears in `admin-frontend/src/pages/SuperAdminLogin.js` (client-side, not a security boundary) and `backend/addsuperadmin.js` (local role-grant script) — neither is an auth gate.
- **Effort:** S

#### [x] P2-5 — Unauthenticated writes — ✅ FIXED 2026-06-07
- **Severity:** Medium
- **Where:** `backend/routes/messages.js` (`/start` wrote guest PII), `backend/server.js` (`/update-status` flips branch presence) — both unauthenticated.
- **Remediation:** Require a guest token on `/start`; authenticate `/update-status` (or accept only signed beacons).
- **Resolution (2026-06-07):** **(1) `/start`** now requires `authenticateGuest`; the guest identity (`guestId` + `branchEmail`) is taken from the verified token and the body values are ignored, so a caller can only create/overwrite their OWN guest record for their OWN branch (closes the unauthenticated arbitrary-PII write). It had no production frontend caller (only the edge public-list entry + a dev mock), so no flow breaks. **(2) `/update-status`** now requires `authenticateBranchAdmin` and marks offline using the server-resolved `req.branchEmail` (token), ignoring the client-supplied `email` — so nobody (authenticated or not) can flip an arbitrary branch's presence. **(3) Beacon auth:** `authenticateBranchAdmin` gained a `?token=` query-param fallback (mirroring `authenticateGuest`) because `navigator.sendBeacon` can't set an `Authorization` header and the `fetch` fallback doesn't send the cookie; the admin frontend (`AuthContext.js`, `Admin-Utils-socket.js`) now appends `?token=<branchAdminToken>` to the `/update-status` URL. Edge unchanged: it already gates `/update-status` via the forwarded `branchAdminToken` cookie, and forwards the query string, so prod-via-edge works via cookie while direct-origin/dev works via the query token. (Note: branch *online* presence is still primarily socket-driven; this endpoint is only the tab-close offline fallback.)
- **Effort:** S

### LOW / HARDENING

#### [x] P3-1 — Edge CSP allows `script-src 'unsafe-inline'` — ✅ FIXED 2026-06-08
- **Where:** `magis-edge-worker/index.js` `cspForSpa()` — the edge (the actual SPA server: it proxies `ADMIN_URL`/`GUEST_URL` and overrides the CSP header) emitted `script-src 'unsafe-inline'`. The SPA builds already ship a `<meta>` CSP + `nonce="…"` on every inline `<script>` + `window.__CSP_NONCE`, but all keyed to a **static build-time placeholder `xyz123`** that nothing ever replaced — so the nonce was public/worthless and `'unsafe-inline'` made inline injection trivial.
- **Resolution (2026-06-08):** The edge now performs **per-request nonce substitution** on HTML responses: it generates a fresh 128-bit hex nonce and replaces the `xyz123` placeholder in the `nonce="…"` attributes, the baked `<meta>` CSP (`'nonce-…'`), and `window.__CSP_NONCE` (which runtime SDK loaders like `FacebookLatestVideo.jsx` read to tag dynamically-injected scripts). It emits a matching nonce-based `Content-Security-Policy` header with **`script-src 'self' 'nonce-<n>' <hosts>` and NO `'unsafe-inline'`**. Same-origin bundles match `'self'`; reCAPTCHA/Maps/FB match the host allowlist or the propagated nonce, so the *set* of executable scripts is unchanged — only the nonce value becomes unpredictable. `style-src 'unsafe-inline'` is intentionally KEPT (React renders inline `style=""` attributes that nonces/hashes can't cover; style injection is far lower risk). A `CSP_MODE="legacy"` wrangler var provides an instant rollback. Verified by a 14-assertion logic smoke test (substitution leaves no `xyz123`; hardened header has no `'unsafe-inline'`; legacy restores it). **Note:** the backend's own `build/` + helmet path is unaffected and is moot under the P2-2 origin lock-down (all prod traffic is edge-served). **Effort:** M

#### [x] P3-2 — `trust proxy: true` enables XFF spoofing for IP rate limits — ✅ FIXED 2026-06-08
- **Where:** `backend/server.js` — `app.set("trust proxy", true)` trusted the ENTIRE `X-Forwarded-For` chain, so `req.ip` was the left-most (client-controlled) value. A direct-to-origin caller could rotate fake `X-Forwarded-For` headers to mint unlimited per-IP rate-limit buckets, defeating the login/guest-init/guest-contact limiters.
- **Resolution (2026-06-08):** **(1)** `trust proxy` is now pinned to a configurable hop count via `TRUST_PROXY` (parser supports an integer, `"false"`, or a CSV of trusted IPs/CIDRs; default `1`) instead of `true`. **(2)** More importantly, every per-IP limiter (`guestInitLimiter`, `guestContactLimiter`, `loginLimiter`, `fbLimiter` in `server.js`; the branch-admin `loginLimiter` in `routes/branchadminauth.js`) now uses a shared `keyGenerator: rateLimitKey` (new export in `utils/geoSecurity.js`). It keys off the **edge-authenticated** client IP — the Cloudflare worker strips client `X-Forwarded-For` and sets one authoritative entry gated by `X-Edge-Auth` — and only falls back to the pinned `req.ip`/raw socket peer for untrusted/direct traffic, so a spoofed `X-Forwarded-For` is never used as the key. This also decouples rate-limit correctness from the exact hop count (no global-throttle risk if `TRUST_PROXY` is mis-set). A static number can't be correct for both the via-edge chain (more hops) and a direct bypass (fewer), so full spoof-resistance on direct traffic is completed by P2-2 enforce mode. Verified: `node --check` clean on all 3 files + an 11-assertion logic smoke test (edge-trusted → real client IP; untrusted → spoofed XFF ignored, falls back to `req.ip`/socket). **Effort:** S

#### [x] P3-3 — Non-constant-time MFA comparisons; weak backup-code entropy — ✅ FIXED 2026-06-08
- **Where:** `backend/utils/mfa.js` — `verifyTOTP` compared codes with `===` (and early-`return`), `verifyBackupCode` used `.includes()`, both timing side-channels; `generateBackupCodes` used `crypto.randomBytes(4)` = only **32 bits** of entropy (brute-forceable for a single-use recovery secret).
- **Resolution (2026-06-08):** Added a `constantTimeEqual()` helper (`crypto.timingSafeEqual` + length guard). **(1)** `verifyTOTP` now compares against every token in the drift window with `constantTimeEqual` and **no early-exit** (the `i===0` step covers the exact match), so neither the expected code nor which step matched leaks via timing. **(2)** `verifyBackupCode` does a constant-time, no-early-exit membership check (hash-vs-hash). **(3)** `generateBackupCodes` now uses `crypto.randomBytes(8)` = **64 bits** (16 uppercase hex chars). **(4)** `hashBackupCode` normalizes input (uppercase + strip separators) so codes verify with/without spacing — and because legacy 8-char hex codes have no separators, their stored hashes are **unchanged** (backward compatible). The admin `MFAVerifyModal.js` was synced to accept **both** legacy 8-char and new 16-char codes (regex/`maxLength`/slice/enable) so already-enrolled admins aren't locked out.
- **Context discovered:** `backend/utils/mfa.js` is currently **not imported anywhere**, and the `/api/mfa/setup|verify-setup|verify` endpoints the frontend modals call are **not defined** in `routes/mfa.js` (which only does session tracking) — the live second factor is **Firebase MFA** (`hasFreshSecondFactor` checks `firebase.sign_in_second_factor === 'totp'`). So this hardens a utility module that isn't on a live request path today; the fix is correct hygiene for if/when it's wired. Verified: `node --check` clean + a **17-assertion** unit smoke test against the real module (64-bit codes; TOTP window accept/reject; backup verify + case/separator tolerance + legacy-hash backward compatibility). **Effort:** S

#### [x] P3-4 — Auth token accepted via `?token=` query parameter — ✅ FIXED 2026-06-08
- **Where:** `backend/middlewares/authenticateGuest.js` accepted the JWT from `req.query.token` (and `authenticateBranchAdmin.js` had the **identical** `?token=` fallback added in P2-5). Query strings leak into server access logs, browser history, proxy/CDN logs, and outbound `Referer` headers — so a bearer credential ended up in many durable, hard-to-scrub places.
- **Resolution (2026-06-08):** Both middlewares now take the header-less fallback token from the **JSON request body** (`req.body.token`) instead of the query string; precedence is **Authorization header → cookie → body**, and a `?token=` query param **no longer authenticates at all**. The two header-less flows that needed it — the guest tab-close beacon (`Guest-Chat-Box-Component.js` → `POST /api/guest/force-close`) and the admin offline beacon/fetch (`AuthContext.js` + `Admin-Utils-socket.js` → `POST /api/update-status`) — already send a JSON body via `navigator.sendBeacon`/`fetch`, so the token simply moved into that body (request bodies are not written to access logs / history / Referer). Body parsing is guaranteed before auth: app-level `express.json()` (`server.js:219`) precedes the guest router (`:418`), and `/api/update-status` has its own `express.json()` before `authenticateBranchAdmin` (`:696-697`). Confirmed guest media is unaffected — `mediaResolver.js` uses an `Authorization: Bearer` `fetch` (not an `<img>` query token) and returns a separately-signed URL.
- **Note:** Verified `node --check` clean on both middlewares + a 10-assertion smoke test of the token-source precedence (header > cookie > body; `?token=` alone → 401 for both guest and admin), and a repo scan confirming no `?token=`/`searchParams.set("token")` code remains in either frontend (only explanatory comments). During deploy a stale cached frontend's beacon may 401 briefly (presence flips offline a little late) until the new bundle loads — best-effort beacons only, no functional break. **Effort:** S

#### [x] P3-5 — No `iss`/`aud` binding on JWTs — ✅ FIXED 2026-06-08
- **Where:** `backend/workers/secretWorker.js` minted/verified JWTs with **no `iss` and no `aud`** claims, so a token was bound only by its signature + `role`. A token from another deployment/issuer (or a leaked shared secret reused by another service) would verify, and role separation relied solely on each endpoint's `role` check with no crypto-layer audience binding.
- **Resolution (2026-06-08):** Added a central, rollout-safe claim policy in `backend/utils/jwtKeys.js` (`JWT_ISSUER`, role→audience map `AUDIENCES`, `audienceForRole`, pure `checkClaims`, mode-gated `enforceClaims`, `getClaimsPolicy`). **(1) Sign:** the worker now stamps **every** token with `iss` (default `magis-api`) and a **role-derived `aud`** (`user`→`magis-guest`, `branchadmin`→`magis-admin`, `superadmin`→`magis-superadmin`; caller-supplied values still win) — covering all six mint sites (guest init/refresh, branch-admin login, superadmin login, superadmin-from-Firebase, fallback token) with **zero route changes**. **(2) Verify:** the worker and `verifyLocal` apply `enforceClaims` after signature/`jti` checks — it verifies `iss` matches policy and `aud` matches the token's **own role** (which, combined with each endpoint's existing role check, means an endpoint effectively only accepts tokens whose audience matches that role). The single guest/admin socket path and the multi-role logout/rotation verifies are all handled by this one role-keyed check. **(3) Rollout** mirrors the RS256/edge pattern via `JWT_VERIFY_CLAIMS` = `monitor` (default: stamp + log mismatches, never reject) → `enforce` (reject wrong/missing `iss`/`aud`) → `off`. Tokens are **always** stamped, so claims exist before enforcement; flip to `enforce` only after the longest TTL (**branch-admin login = 8h**) has elapsed so pre-rollout claim-less tokens have expired. New env vars forwarded into the worker via `secretPool.js` `workerData` and documented in `backend.env.example`.
- **Safety:** **Firebase ID tokens are untouched** — they fail our signature check in the worker and fall back to `admin.auth().verifyIdToken` upstream, so `enforceClaims` only ever runs on tokens our own keys verified. Logout/rotation verifies are wrapped in try/catch (a claim throw still clears the cookie). Verified `node --check` clean on `jwtKeys.js`/`secretPool.js`/`secretWorker.js` + a **21-assertion** smoke test: policy logic across `monitor`/`enforce`/`off`, plus an **end-to-end sign→verify through the real `secretPool` worker** proving tokens get `iss`/`aud` stamped and that `enforce` rejects foreign-issuer, role/audience-mismatch, and legacy (claim-less) tokens.
- **Edge defense-in-depth (2026-06-08):** the Cloudflare edge worker (`magis-edge-worker/index.js`) previously verified the admin JWT **signature + role** only. It now also runs `checkAdminClaims(payload)` on the admin gate — verifying `iss` matches `JWT_ISSUER` and `aud` matches `JWT_AUD_ADMIN` (`magis-admin`) — gated by the **same** `JWT_VERIFY_CLAIMS` mode (`monitor` default logs only, `enforce` blocks with 401, `off` skips). So a validly-signed token for another role/issuer/deployment can't satisfy the edge admin gate. Documented in `wrangler.toml`. **Rollout order:** ship origin + edge in `monitor` → flip **origin** to `enforce` (+ wait the 8h admin TTL) → then set edge `JWT_VERIFY_CLAIMS=enforce`. Verified `node --check` clean + a **12-assertion** test that loads the real `index.js` in a `vm` sandbox (asserts mode resolution + the iss/aud truth table: valid/array-aud accepted; foreign-issuer, guest/superadmin audience, and legacy claim-less tokens rejected).

#### [x] P3-6 — Latent functional bug: `sharp` referenced but removed — ✅ FIXED 2026-06-07 (via P1-3)
- **Where:** `backend/routes/messages.js:534` uses `sharp`, but the import is commented out at `:20`; admin image replies will throw. (Reliability, not security — included so it isn't lost.) **Effort:** S
- **Resolution:** The P1-3 rewrite of the admin reply media path removed the `sharp`/webp resize entirely — admin image replies now store the original image privately, so the missing-`sharp` ReferenceError can no longer occur.

#### [x] P3-7 — JWT secret-worker pool hardening (external OWASP review of `secretPool.js`) — ✅ FIXED 2026-06-13
- **Context:** A third-party OWASP-mapped review of `backend/utils/secretPool.js` (the PERF3-1 round-robin secret-worker pool) raised four items: (1) **CRITICAL** parameter-override in `verifyJWT`, (2) `JWT_SECRET` read on the main thread, (3) worker crash-loop DoS, (4) unbounded callback-map OOM. The review saw **only `secretPool.js`** — not `workers/secretWorker.js` / `utils/jwtKeys.js`, which are the actual trust boundary — so its severities were re-assessed against the full code before fixing.
- **⚠️ Finding 1 was MISDIAGNOSED (CRITICAL → Low) and the reviewer's suggested fix is HARMFUL — do NOT apply it.** The worker ignores caller `algorithms`/`clockTolerance` and derives the verify algorithm from the token under the alg-confusion-safe key policy (`jwtKeys.getVerifyParamsForToken`: RS256→public key only, HS256→secret only), applying `algorithms: vparams.algorithms` **last** in `jwt.verify` (`secretWorker.js:233-236`); `alg:"none"`/unknown → `UnsupportedAlgorithm`. Every `verifyJWT` call site passes **hardcoded** options (no `verifyJWT(req.body…)` pattern exists in the repo). The reviewer's proposed static `algorithms: ["HS256","RS256"]` list would **re-introduce the RS256→HS256 confusion-forgery** that `getVerifyParamsForToken` exists to prevent. The only genuine residual was the worker honoring a caller-supplied `ignoreExpiration`.
- **Item 1 — `verifyJWT` option lockdown (commit `1645390`):** public `verifyJWT` now hard-strips `ignoreExpiration` + `clockTimestamp` (the only options that can *weaken* verification), so no caller can accept an expired/instant token through it. Added `verifyAllowExpired(token)` as the **sole sanctioned** ignore-expiration path (same worker pipeline: signature + alg-confusion + revocation + claims). Migrated the three legitimate users — superadmin logout, branchadmin logout, and fallback-token rotation (`server.js`) — onto it.
- **Item 2 — main-thread raw verify removed (commit `1645390`):** the guest force-close path did a raw `jwt.verify(token, process.env.JWT_SECRET, …)` that both re-read the secret on the main thread **and** bypassed the central policy (it would silently break after an RS256 cutover). Replaced with `verifyAllowExpired` (worker path, alg-confusion-safe, RS256-ready); removed the now-orphaned `jsonwebtoken` import. **Note:** *full* main-thread secret isolation (the in-code comment overstates "only inside workers") is an **infra** task, not a code one-liner — `worker_threads` inherit a copy of `process.env` and most PaaS inject env vars process-wide, so true zero-knowledge needs a secret-manager fetch performed *inside* the worker. Tracked as future hardening.
- **Item 3 — crash back-off (commit `bf0c545`):** only **repeated rapid** crashes (≥2 within 10s) on a slot arm a cooldown; an isolated crash still respawns immediately (unchanged). `pickWorker` **skips** cooling slots and, if all are cooling, respawns the soonest-recovering one anyway — it **never rejects**, so the hot path always serves at least as many requests as before. `broadcastToPool` (revoke) is deliberately unchanged, preserving cross-worker in-memory revocation consistency; `shutdown()` guards against arming cooldowns mid-teardown. (The worker handler is fully `try/catch`-wrapped, so a malformed token cannot crash a worker — this guards only exotic native/OOM faults.)
- **Item 4 — queue backpressure (commit `bf0c545`):** a high-watermark cap on in-flight callbacks (`JWT_WORKER_MAX_QUEUE`, default 10000, floored to `POOL_SIZE×16`) sheds load by rejecting overflow with a distinct `err.code="EWORKERBUSY"` instead of growing the map toward OOM; **revoke is exempt** (rare + security-critical). Mapped `EWORKERBUSY` → **HTTP 503** (transient/retryable) across **6 verify sites** — `authenticateGuest`/`authenticateBranchAdmin`/`authenticateSuperAdmin`, `branchadminauth /profile`, `superadminauth /verify`, and the socket auth path (→ retryable `ServiceBusy`). The **Firebase fallback** in branchadmin + socket is preserved (503 only at the final failure when the saturated HMAC path was the cause), so a valid Firebase token still authenticates during a flood. The cap sits far above real concurrency (in-flight ≈ request-rate × ms latency), so it never trips in normal/bursty operation. **Caveat:** the cap can also fire on the *sign* path (login); that is **not** mapped to 503 (out of scope) but is no worse than today's timeout behavior, and logins are rate-limited.
- **Zero-compromise verified:** `node --check` clean on all touched files (`secretPool.js`, `server.js`, `socket.js`, the 3 auth middlewares, the 2 auth routes). A live smoke test against the **real 2-worker pool** passed **6/6**: normal sign/verify intact; a 40-call synchronous burst over a cap of 32 yielded **exactly 8 `EWORKERBUSY` + 32 ok**; and the item-1 strip held (expired token **rejected** via `verifyJWT(…{ignoreExpiration:true})`, **accepted** via `verifyAllowExpired`). **Effort:** M

---

## 4. Philippine legal & regulatory mapping

| Law / regulator | Relevance to this platform | Findings |
| --- | --- | --- |
| **RA 10173 — Data Privacy Act 2012 + NPC IRR/Circulars** | Processing of sensitive personal information (gov't IDs, financials); requires technical safeguards, DPO, system registration, privacy notice, and **72-hour breach notification**. Admin fines up to ₱5M/violation (NPC Circ. 2022-01). | P0-1, P0-2, P1-1, P1-2, P1-3, P2-* |
| **PD 114 + BSP Circular 1048 (pawnshop/MSB supervision)** | Pawnshops are BSP-supervised; governance and record protection. | P0-1, P0-2, P1-3 |
| **BSP Circulars 982/1019 (IT & cyber risk management)** | Access control, key management, monitoring, incident response. | P0-2, P2-1, P2-2, P2-3 |
| **RA 11765 — Financial Consumer Protection Act + BSP Circ. 1160** | Security of digital channels; no misleading representations; complaint handling. | P1-1, P1-4, P1-5 |
| **RA 9160 — AMLA (as amended)** | KYC record protection; **5-year retention**; suspicious-transaction handling. | P1-3, retention policy |
| **RA 8792 (E-Commerce), RA 10175 (Cybercrime), RA 11934 (SIM Registration)** | Electronic-record integrity; lawful incident handling; phone-number handling. | Cross-cutting |

**Organizational/legal to-dos (non-code):**

- [ ] Appoint and register a **Data Protection Officer** with the NPC.
- [ ] Register the data-processing system with the NPC; publish a **privacy notice**.
- [ ] Document a **breach-response runbook** that meets the 72-hour NPC notification window.
- [ ] Define **data-retention & disposal** (align with AMLA 5-year rule) with crypto-shredding on expiry.

---

## 5. Remediation roadmap

**Phase 0 — Immediate (P0)**
- [x] P0-1 Lock down `/api/issue-fallback-token` — ✅ done 2026-06-07
- [x] P0-2 Enforce `requireMFA` on SPI routes — ✅ done 2026-06-07 (effective via conversation-key gate; plaintext gap tracked in P1-6)
- [ ] P0-3 Rotate leaked SA key + purge git history (owner) — untracked/ignored 2026-06-07

**Phase 1 — Week 1 (P1)**
- [x] P1-1 Label corrected + `CONV_KEY_SECRET` wired (set value in Render); managed-key model retained, KMS/true-E2EE deferred — 2026-06-07
- [x] P1-2 Bind socket `joinRoom` to the verified token identity (admins + guests) — ✅ 2026-06-07
- [x] P1-3 Private media + signed URLs — ✅ 2026-06-07 (then run `backend/scripts/migrate-media-private.js --apply`)
- [x] P1-4 UUID IDs + proof-required refresh + per-IP /init rate-limit + Cloudflare Turnstile — ✅ 2026-06-07 (set `TURNSTILE_SECRET` in Render to enforce the CAPTCHA)
- [x] P1-5 Lock down `/contact` — auth (guest token) + server-resolved branch-only recipient + HTML-escape + rate-limit — ✅ 2026-06-07

**Phase 2 — Weeks 2-4 (P2)**
- [ ] P2-1 Provision Redis + edge KV — code hardening shipped 2026-06-07 (observability + `REQUIRE_REDIS`/`JWT_REVOCATION_FAIL_CLOSED`/`RATE_LIMIT_FAIL_CLOSED` toggles); **infra still pending operator** (set `REDIS_URL`, create+bind `RATE_LIMIT_KV`)
- [ ] P2-2 Lock origin to the edge — backend `requireEdgeAuth` shipped 2026-06-07 (mounted on `/api`, `EDGE_AUTH_MODE` default monitor); **infra pending operator** (`wrangler secret put EDGE_SHARED_SECRET` + set same on backend → confirm in monitor → `EDGE_AUTH_MODE=enforce`)
- [ ] P2-3 Asymmetric JWT signing — RS256 dual-alg support shipped 2026-06-07 (`JWT_ALG` default HS256 = zero change; alg-confusion-safe; `backend/scripts/generate-jwt-keypair.js`); **key provisioning + cutover pending operator** (provision keys → `JWT_ALG=RS256` → after ~4h `JWT_ACCEPT_HS256=false` + drop edge `JWT_SECRET`)
- [ ] P2-4 Secret hygiene + token rotation — code done 2026-06-07 (removed secret/private-key logging, deleted dev-fallback secret, externalized `SUPERADMIN_EMAILS`; zips already ignored + never committed); **operator: rotate Cloudflare token, set `SUPERADMIN_EMAILS` in Render, optionally delete local zips**
- [x] P2-5 Authenticate `/start` (guest token, identity from token) and `/update-status` (branch-admin token for sendBeacon — moved from `?token=` to the JSON body by P3-4 — server-resolved branch) — ✅ 2026-06-07

**Phase 3 — Strategic (P3)**
- [ ] Passkeys / WebAuthn for staff login
- [ ] KMS/HSM key custody + crypto-shredding
- [ ] Tamper-evident audit logs + SIEM export
- [x] Edge CSP nonces — ✅ 2026-06-08 (P3-1: per-request nonce substitution, `script-src` no longer `'unsafe-inline'`); supply-chain scanning (Dependabot/SBOM) still pending
- [x] Hardening item P3-5 — ✅ 2026-06-08 (P3-1 ✅, P3-2 ✅, P3-3 ✅, P3-4 ✅, P3-5 ✅, P3-6 ✅)
- [x] P3-7 secret-worker pool hardening (external OWASP review of `secretPool.js`) — ✅ 2026-06-13 (items 1–4: `verifyJWT` option lockdown + `verifyAllowExpired`, main-thread raw-verify removed, crash back-off, queue backpressure → 503; reviewer's CRITICAL downgraded as misdiagnosed and the alg-list "fix" rejected as harmful)

---

## 6. "Trust by Design" — differentiator program

Security features the pawnshop can credibly market once the gaps above are closed:

- **Phishing-resistant staff login** (passkeys / FIDO2 / WebAuthn) — current industry gold standard, beyond TOTP.
- **Verifiable privacy** — accurate encryption claims, KMS-held keys, NPC registration, named DPO, published privacy notice.
- **Automatic ID redaction (DLP)** — already implemented (`backend/routes/messages.js:138-263`); promote it.
- **Location-aware MFA step-up** — already implemented (`backend/routes/mfa.js`); promote once server-enforced (P0-2).
- **Tamper-evident audit trail** — extend `securityAnomalies` / `sensitiveMessageAudit` into hash-chained, exportable logs for breach forensics.

---

## 7. Notes, assumptions & verification needed

- Production environment variables were **not** inspected directly; conclusions about `CONV_KEY_SECRET`, `EDGE_SHARED_SECRET`, and `REDIS_URL` are inferred from `backend/backend.env.example` and code fallbacks. **Confirm the live Render/Cloudflare configuration.**
- Confirm whether the Render origin is reachable directly (bypassing Cloudflare) from the public internet (P2-2).
- Confirm whether `backend.zip` / `user-frontend.zip` were ever committed or deployed (P2-4).
- Severity ratings are qualitative; commission an independent penetration test before public security claims.

*End of document.*
