# Magis Pawnshop — Security Remediation Plan

**Status:** Draft for stakeholder review
**Scope:** `backend/` (Express + Firebase + Socket.IO), `magis-edge-worker/` (Cloudflare), `admin-frontend/`, `user-frontend/`
**Prepared by:** Engineering (security review)
**Last updated:** 2026-06-07

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

#### [ ] P0-2 — Server-side MFA is never enforced
- **Severity:** Critical
- **Where:** `backend/middlewares/requireMFA.js` exists but is **applied to zero routes** (verified by search). Sensitive endpoints rely only on `authenticateBranchAdmin`: `backend/routes/messages.js:606` (history), `:697`/`:719` (conversation-key), `:641` (`/all`).
- **Risk:** The MFA step-up and geo-lock logic in `backend/routes/mfa.js` is effectively **client-side only**. A token obtained without MFA (see P0-1) can read customer data.
- **PH legal driver:** DPA 2012 (access control on sensitive personal information); BSP IT-risk; RA 11765.
- **Remediation:** Apply `requireMFA` to the SPI-bearing routes and source `mfaVerified` from the existing `mfa_sessions` Firestore record.
- **No-regression note:** Admins who have completed TOTP already have a valid session document, so normal usage is unaffected.
- **Effort:** S-M

### HIGH

#### [ ] P1-1 — "End-to-end encrypted" is server-escrowed encryption
- **Severity:** High
- **Where:** Key generated/stored/served by backend: `backend/routes/messages.js:113-133`, `:697-736`; client imports server key in `user-frontend/src/utils/e2eeCrypto.js:226-242`. At-rest wrapping is **disabled unless `CONV_KEY_SECRET` is set** (`backend/routes/messages.js:75-84`), and that variable is **absent from `backend/backend.env.example`**. UI claims true E2EE.
- **Risk:** A database/admin compromise can decrypt all messages. Marketing/labeling the channel as E2EE while the server holds keys is a **transparency/representation** issue.
- **PH legal driver:** DPA 2012 (transparency, security measures); RA 11765 + DTI (no misleading representations to consumers).
- **Remediation (choose):** (a) Re-label to "encrypted in transit and at rest" and move key custody to a managed KMS/HSM; or (b) restore genuinely client-held keys. **Immediately:** set `CONV_KEY_SECRET` so stored keys are wrapped.
- **No-regression note:** Messaging behaviour is unchanged under either option.
- **Effort:** S (set secret) / M-L (KMS or true E2EE)

#### [ ] P1-2 — Cross-branch live message leak via socket `joinRoom`
- **Severity:** High
- **Where:** `backend/utils/socket.js:488-494` joins `admin-<client-supplied-room>` with no check that the room is the admin's own branch.
- **Risk:** A branch-A admin can subscribe to branch-B's live conversations (tenant isolation break / IDOR).
- **PH legal driver:** DPA 2012 (unauthorized access / data segregation).
- **Remediation:** Ignore the client-supplied room for admins; bind strictly to `socket.user.email`.
- **No-regression note:** Admins already auto-join the correct branch room at connection time (`backend/utils/socket.js:386-398`), so legitimate behaviour is unchanged.
- **Effort:** S

#### [ ] P1-3 — Customer-uploaded media is world-public
- **Severity:** High
- **Where:** `backend/utils/firebase.js:129` and `backend/routes/messages.js:42` call `file.makePublic()` on every upload.
- **Risk:** Photos of IDs, pawned items, and receipts become permanent public URLs accessible without authentication.
- **PH legal driver:** DPA 2012 (sensitive personal information must be access-controlled); AMLA (KYC record protection).
- **Remediation:** Keep objects private; serve through short-lived signed URLs scoped to the conversation participants.
- **No-regression note:** The chat UI receives a signed URL instead of a public one; images still display.
- **Effort:** M

#### [ ] P1-4 — Guest tokens mintable/refreshable without proof; predictable IDs; no server-side CAPTCHA
- **Severity:** High
- **Where:** `backend/routes/guest.js:81-128` (`/init`), `:317-359` (`/refresh-token`); IDs formed as `guest-<timestamp>` (`guest.js:90`); only `REACT_APP_RECAPTCHA_SITE_KEY` exists (no server-side verify — confirmed by search).
- **Risk:** Anyone can mint/refresh guest sessions for arbitrary IDs; enumerable IDs enable targeting; no real bot protection on public endpoints.
- **PH legal driver:** DPA 2012 (integrity/abuse); RA 11765 (channel integrity).
- **Remediation:** Random UUID guest IDs; verify reCAPTCHA/Cloudflare Turnstile server-side on `/init`; require the prior token on refresh.
- **No-regression note:** Token contents/flow unchanged for legitimate guests.
- **Effort:** M

#### [ ] P1-5 — Open email relay / spam via contact endpoint
- **Severity:** High
- **Where:** `backend/routes/guest.js:216-253` (`/contact`) is unauthenticated, emails attacker-controlled `to: [branchEmail, guestEmail]` with attachments via the support Gmail; HTML body built by string interpolation (`:239`).
- **Risk:** Abuse to send arbitrary email from your domain (blacklist/reputation damage), HTML injection.
- **PH legal driver:** RA 11765 (consumer-facing channel integrity); anti-spam good practice.
- **Remediation:** Turnstile-gate or authenticate; restrict recipient to the resolved branch address; encode/sanitize the body; rate-limit.
- **Effort:** S-M

### MEDIUM

#### [ ] P2-1 — Rate limiting and token revocation are likely inert in production
- **Severity:** Medium
- **Where:** Redis defaults to localhost (`backend/utils/redis.js:24-27`); backend silently swallows Redis errors (`backend/server.js:44-53`); edge KV unbound → fail-open (`magis-edge-worker/index.js:184-198`, `magis-edge-worker/wrangler.toml:26-29`); in-memory revocation only when `REDIS_URL` unset (`backend/workers/secretWorker.js:21-44,165-173`).
- **Risk:** Login brute-force protection and logout/force-close **revocation** may not function across instances/restarts.
- **PH legal driver:** BSP IT-risk; DPA 2012 (session management).
- **Remediation:** Provision managed Redis (`REDIS_URL`) and bind the edge KV namespace.
- **Effort:** S (infra)

#### [ ] P2-2 — Origin is not locked to the edge
- **Severity:** Medium
- **Where:** Backend directly reachable (`magis-edge-worker/wrangler.toml:20`); `EDGE_SHARED_SECRET` absent from env template → trust **fails open** (`backend/utils/geoSecurity.js:48-52`).
- **Risk:** Edge JWT/rate/geo controls are bypassable by hitting the origin directly; geo headers spoofable.
- **Remediation:** Set `EDGE_SHARED_SECRET` and reject non-edge traffic, or use Cloudflare Tunnel / mTLS origin authentication.
- **Effort:** S-M

#### [ ] P2-3 — One symmetric JWT secret shared across edge and origin
- **Severity:** Medium
- **Where:** HS256 secret used in both Cloudflare (`magis-edge-worker/index.js:101,380-383`) and backend (`backend/workers/secretWorker.js:104,131`).
- **Risk:** Compromise of either system forges tokens for all roles.
- **Remediation:** Move to asymmetric signing (EdDSA/RS256): backend holds the private key; edge verifies with the public key only.
- **No-regression note:** Tokens remain JWTs; only the signing/verification keys change.
- **Effort:** M

#### [ ] P2-4 — Secret hygiene
- **Severity:** Medium
- **Where:** `JWT_SECRET` prefix logged at boot (`backend/server.js:7,22`; `backend/utils/secretPool.js:26`; `backend/workers/secretWorker.js:13`); hardcoded dev fallback secret (`backend/utils/secretPool.js:25`); hardcoded superadmin email (`backend/server.js:319`); `backend/backend.zip` and `user-frontend/user-frontend.zip` are **not covered by `.gitignore`** and may bundle secrets; Cloudflare API token from earlier work still needs rotation.
- **Remediation:** Remove secret logging; delete the dev fallback constant; externalize the superadmin allowlist to config; delete/ignore the zip archives; rotate the Cloudflare token; consider a secrets manager.
- **Effort:** S

#### [ ] P2-5 — Unauthenticated writes
- **Severity:** Medium
- **Where:** `backend/routes/messages.js:322-357` (`/start` writes guest PII), `backend/server.js:469-497` (`/update-status` flips branch presence) — both unauthenticated.
- **Remediation:** Require a guest token on `/start`; authenticate `/update-status` (or accept only signed beacons).
- **Effort:** S

### LOW / HARDENING

#### [ ] P3-1 — Edge CSP allows `script-src 'unsafe-inline'`
- **Where:** `magis-edge-worker/index.js:141` — undercuts the nonce-based CSP set by the backend on the actually-served SPA. Move toward nonces/hashes. **Effort:** M

#### [ ] P3-2 — `trust proxy: true` enables XFF spoofing for IP rate limits
- **Where:** `backend/server.js:63` — pin to the known proxy hop count. **Effort:** S

#### [ ] P3-3 — Non-constant-time MFA comparisons; weak backup-code entropy
- **Where:** `backend/utils/mfa.js:62-68` (string compare), `:45` (32-bit backup codes) — use constant-time compare and ≥ 64-bit codes. **Effort:** S

#### [ ] P3-4 — Guest token accepted via `?token=` query parameter
- **Where:** `backend/middlewares/authenticateGuest.js:21-22` — leaks tokens into logs/history/referrers; prefer header/cookie only. **Effort:** S

#### [ ] P3-5 — No `iss`/`aud` binding on JWTs
- **Where:** `backend/workers/secretWorker.js` — add issuer/audience claims and verification to harden token reuse across roles/services. **Effort:** S

#### [ ] P3-6 — Latent functional bug: `sharp` referenced but removed
- **Where:** `backend/routes/messages.js:534` uses `sharp`, but the import is commented out at `:20`; admin image replies will throw. (Reliability, not security — included so it isn't lost.) **Effort:** S

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
- [ ] P0-2 Enforce `requireMFA` on SPI routes

**Phase 1 — Week 1 (P1)**
- [ ] P1-1 Set `CONV_KEY_SECRET`; decide E2EE labeling vs KMS custody
- [ ] P1-2 Bind socket `joinRoom` to the admin's own branch
- [ ] P1-3 Private media + signed URLs
- [ ] P1-4 UUID guest IDs + server-side Turnstile + refresh requires prior token
- [ ] P1-5 Lock down `/contact`

**Phase 2 — Weeks 2-4 (P2)**
- [ ] P2-1 Provision Redis + edge KV
- [ ] P2-2 Lock origin to the edge
- [ ] P2-3 Asymmetric JWT signing
- [ ] P2-4 Secret hygiene + token rotation
- [ ] P2-5 Authenticate `/start` and `/update-status`

**Phase 3 — Strategic (P3)**
- [ ] Passkeys / WebAuthn for staff login
- [ ] KMS/HSM key custody + crypto-shredding
- [ ] Tamper-evident audit logs + SIEM export
- [ ] Edge CSP nonces; supply-chain scanning (Dependabot/SBOM)
- [ ] Hardening items P3-1 … P3-6

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
