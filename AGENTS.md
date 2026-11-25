# AGENTS.md

Monorepo with no root build — run commands inside each component.

## Checks
- `backend/` — `npm test` (node:test, hermetic, no credentials)
- `user-frontend/` — `npm run test:ci` (Jest) · `npm run build` (CRA + prerender) · `npx playwright test` (runs against `build/`, so build first)
- `admin-frontend/` — `CI=true npx react-scripts test --watchAll=false` · `npm run build` · `npx playwright test`
- `magis-edge-worker/` — single `index.js`, deployed with `node deploy-api.mjs`; no test suite of its own

## Live chat is parked (search for `CHAT-PARK`)
The guest↔branch live chat is switched off by default. The code is kept on purpose — do not delete it.
- Switches, all off unless set to `true`: `REACT_APP_CHAT_ENABLED` (build-time; guest site and admin console, `src/config/features.js` in each) and `CHAT_ENABLED` (backend runtime, `backend/utils/chatFeature.js`). Re-enable = set all three to `true`, rebuild both frontends, redeploy.
- Keep `CONV_KEY_SECRET` set on the backend while chat is off; without it stored conversations can never be decrypted.
- The default build runs the `chat-off` e2e specs. The chat suites need a chat-on build: `npm run build:chat && npm run e2e:chat` (both frontends). Admin Jest and the backend HTTP harness pin the flag on so the existing chat suites keep running.
- Meta descriptions exist twice and must stay byte-identical: each page's `<Seo>` props in `user-frontend/src` and `ROUTE_META` / `branchRouteMeta` in `magis-edge-worker/index.js` (guarded by `user-frontend/src/utils/edgeSeoSync.test.js`).
