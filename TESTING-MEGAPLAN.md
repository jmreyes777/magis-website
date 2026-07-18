# Testing Megaplan (TST0–TST4)

The test pyramid for the Magis stack: backend logic tests (`node:test`, zero
new deps), frontend money-math + component tests (Jest/RTL via craco), content
guardrails, and a hermetic Playwright E2E smoke of the production build — all
enforced on every push to main by `.github/workflows/tests.yml`, with Telegram
paging on failure.

Full plan & decisions: drafted 2026-07-18 (enforcement = push-to-main + page;
refactors = small extractions only; scope = full pyramid, route-level HTTP
tests deferred).

## How to run

```powershell
# Backend logic tests (no credentials needed — runs without backend.env)
cd backend; npm test

# Frontend unit + component + content tests
cd user-frontend; npm run test:ci        # (npm test for watch mode)

# E2E smoke (needs a production build first)
cd user-frontend; npm run build; npm run e2e

# Telegram paging drill: Actions tab → Tests → Run workflow → force_fail=true
```

## Status

- [x] TST0 CI + harnesses (`.github/workflows/tests.yml`: backend/frontend/e2e
      jobs, push-to-main + PR + manual failure drill; Telegram notify job;
      dead CRA stubs deleted; backend `npm test` = `node --test`)
- [x] TST1 money math (extracted `src/utils/pawnMath.js` + `layawayMath.js`
      verbatim from the pages; every interest tier boundary and layaway
      rounding edge pinned; component tests drive the real calculators.
      Evidence 2026-07-18: frontend 75/75 pass · post-extraction build
      prerender "10/10 routes, hydration clean")
- [x] TST2 backend logic (mfa TOTP incl. RFC 6238 vectors, jwtKeys
      alg-confusion policy, secretPool sign/verify/revoke/expiry via real
      worker threads, cache fail-open, backup↔restore round-trip.
      Evidence 2026-07-18: 40/40 pass in 3.8s, no backend.env present.
      **Found+fixed a latent restore bug**: Timestamps with sub-ms nanos
      ≥ 0.5ms drifted +1ms per backup/restore cycle — toDate() rounding was
      double-counted; deserializer now reverses the rounding exactly.
      Also: `firestore-restore.js` main() now guarded by require.main.)
- [x] TST3 E2E smoke (Playwright/Chromium vs `serve -s build`; all /api/**
      mocked, socket.io + cross-origin blocked — incl. client-side Firestore:
      the branches spec asserts graceful degradation; error tripwire fails on
      pageerror/hydration complaints. 5 spec files / 7 tests.
      Evidence 2026-07-18: 7/7 pass (9.2s warm). One real flake was caught and
      fixed during bring-up: static explainer copy on the jewelry page could
      satisfy peso-amount assertions before hydration — all calculator
      assertions are now scoped to the calculator container.)
- [x] TST4 content guardrails (guide structure/SEO budgets/business claims:
      the 10K–24K karat range, stamp table, in-between karats, Tagalog FAQ;
      GUIDE_LINKS consistency. Caught the karat guide meta description at 206
      chars → trimmed to 162 and re-synced the edge worker meta.)

## Suite inventory (2026-07-18)

| Suite | Where | Count | Runtime |
| --- | --- | --- | --- |
| Backend logic + HTTP routes | `backend/tests/*.test.js` | 55 | ~5s |
| Frontend unit/component/content | `user-frontend/src/**/*.test.js` | 75 | ~6s |
| Admin unit/component | `admin-frontend/src/**/*.test.js` | 54 | ~9s |
| E2E smoke | `user-frontend/e2e/*.spec.js` | 7 | ~40s |

### ADM (admin-frontend suite) — added 2026-07-18

- First tests the admin dashboard has ever had; wired into `tests.yml` as the
  `admin` job (react-scripts test, Node 20, CI=true).
- Covered: session bootstrap utils (tab identity, token polling, hydration
  fallback) · e2eeCrypto with REAL ECDH P-256 handshakes + AES-256-GCM
  roundtrips/tampering via Node webcrypto (no mocks) · waitForCustomClaims
  quota-safety (the auth/quota-exceeded prod incident is pinned as a test) ·
  ProtectedRoute hydration gating, role checks, multi-tab socket-owner
  fallback · mediaResolver signed-URL TTL cache · reportWebVitals
  version-shape guardrail (v2/v4/v5) — makes web-vitals majors mergeable.
- CRA jest-27 workarounds, all in `setupTests.js` or package.json `jest` key:
  polyfills (crypto.randomUUID, webcrypto.subtle, TextEncoder/Decoder,
  BroadcastChannel stub) and moduleNameMapper for react-router-dom@7 (its
  `main` points at a nonexistent `dist/main.js`; jest 27 ignores `exports`).
- Landmine for future tests: CRA jest CANNOT intercept `import("web-vitals")`
  style dynamic imports inside src modules — jest.mock registers, but the
  module's own import bypasses it (proven with a Proxy trace). Test through
  an exported seam instead (see `bindWebVitals`).

### TST5 (route-level HTTP tests) — added 2026-07-18

- `tests/httpHarness.js` boots the REAL app from `server.js` (all middleware,
  limiters, routes, error handler) on an ephemeral port; `NODE_ENV=test` skips
  listen/firebase-init/warmup/pollers/socket-adapter. Firebase creds are
  blanked (accidental Firestore touch → catchable throw, never a real project);
  `utils/firebase` is now LAZY (proxies init on first use; server boots eagerly
  via `initFirebase()`, fail-fast unchanged). Requests use node:http with
  `agent:false` — undici keep-alive handles crash Windows Node under
  `--test-force-exit` (libuv UV_HANDLE_CLOSING assert).
- Covered contracts: csrf-token issuance (fresh 64-hex, readable Strict cookie,
  no-store, BREACH: never compressed) · security envelope (CSP nonce per
  request, nosniff, frame-ancestors, Permissions-Policy, Alt-Svc) · JSON 404s ·
  credential-less + forged-token 401/403 on admin/audit/backup · expired-token
  401 regression · guest-contact 429 + RateLimit headers.
- Bugs found & fixed by this wave:
  1. `routes/messages.js` grabbed the Storage bucket at import (hidden
     dependency on firebase's old import side effects) → lazy `getBucket()`.
  2. Worker-boundary error flattening (`secretPool`/`secretWorker` sent only
     `err.message`): expired/malformed admin tokens surfaced as **500** instead
     of 401 in production (and fed the 5xx spike alarm). Names/codes now cross
     the thread boundary; undecodable tokens classify as `JsonWebTokenError`.
  3. All 8 rate limiters constructed `RedisStore` unconditionally — with no
     REDIS_URL they pointed at a dead localhost Redis. Now `rlStore()` falls
     back to the in-memory store when Redis is not explicitly configured.
  4. Second boot-time env validator (`server.js` ~1392) would `process.exit(1)`
     any credential-less import — including CI. Test-guarded.
- Known quirk (documented, deliberately unfixed): `/api/csrf-token` is
  registered BEFORE helmet, so that one response carries no CSP/nosniff
  envelope. Moving it is a one-line change but alters live header behavior —
  do it deliberately, not as a test side effect.

## Conventions

- Backend tests must run with NO credentials/env file — anything needing
  Firestore/Redis is mocked or out of scope (route-level tests are future
  work, below). node:test runs each file in its own process: per-file env
  setup (`process.env.X = …` before `require`) is safe.
- E2E is hermetic by fixture (`e2e/fixtures.js`): same-origin /api/** get
  minimal JSON mocks, everything else off-box is aborted. New pages that call
  new APIs: add a mock there, or the tripwire will tell you.
- Money math changes REQUIRE a failing test first (they are customer-visible
  pesos). The `opt2` month tiers key off the POST-FEE rounded base — the test
  tables document this deliberately.
- No coverage-% gate (report-only philosophy); the gate is "these suites stay
  green".

## Future work (explicitly out of scope this round)

- Db-backed route tests: a fake-Firestore seam (e.g. `_setDbForTests()` on
  utils/firebase, or Emulator Suite) to exercise guest-session issuance,
  message flows, and branch logins end-to-end.
- Firebase Emulator Suite integration tests; edge-worker tests (miniflare);
  pre-push hooks.
- Admin: page-level tests (login flows with mocked axios/webauthn, chat
  dashboard) once the CRA→Vite migration settles the toolchain.
- Move `/api/csrf-token` behind helmet (see TST5 known quirk).
