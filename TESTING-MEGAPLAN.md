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
| Backend logic | `backend/tests/*.test.js` | 40 | ~4s |
| Frontend unit/component/content | `user-frontend/src/**/*.test.js` | 75 | ~6s |
| E2E smoke | `user-frontend/e2e/*.spec.js` | 7 | ~40s |

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

- Route-level backend HTTP tests (needs utils/firebase lazy-init + fake
  Firestore harness).
- Firebase Emulator Suite integration tests; admin-frontend suite;
  edge-worker tests (miniflare); pre-push hooks.
