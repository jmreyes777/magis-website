# UAT Megaplan — Master Coverage Matrix

One page answering: **what is tested, where, and what is deliberately not.**
Method everywhere: hermetic Playwright against the production bundle — mocked
`/api/*` with real response shapes, third-party surfaces blocked fast, and
socket.io faked at the engine.io v4 protocol level (each suite plays the
*other* side of the wire). Findings were fixed as they surfaced, each with a
regression trap. Detailed narratives live in the two per-app reports:

- `user-frontend/e2e/UAT-REPORT.md` (guest site — findings F-G1…F-G14)
- `admin-frontend/e2e/UAT-REPORT.md` (admin dashboard — findings F1…F13)

## Suite totals (2026-07-26)

| Surface | e2e | Unit | Command |
|---|---|---|---|
| Guest site (`user-frontend`) | **37** | 86 | `npm run build && npm run e2e` · `npm run test:ci` |
| Admin dashboard (`admin-frontend`) | **49** | 73 | `npm run build && npx playwright test` · unit via `react-scripts test` |
| Backend (`backend`) | — | 81 | `npm test` (node:test) |

## Coverage matrix

### Guest site
| Journey | Spec |
|---|---|
| Chat workflow: init → socket → send → deliver → staff reply, typing, E2EE wire proof, sensitive-data interstitial | `uat-10-guest-chat-workflow` |
| Chat resilience: send failures + retry, offline branch, dead socket, token expiry mid-chat, unconfirmed delivery (F-G2) | `uat-11-guest-chat-resilience` |
| Contact form, privacy notice, chat close confirmation, contact-branch modal | `uat-12-guest-pages` |
| Info pages: FAQs accordions, Terms/Privacy, guide hubs, real 404, sticky-map layout mechanism | `uat-13-guest-pages` |
| SEO head contract: unique titles/descriptions, canonicals, per-page OG/Twitter (F-G11), JSON-LD, 404 noindex | `uat-14-seo-contract` |
| Keyboard-only chat (Enter-to-send F-G14), confirm-dialog focus/Escape, accessible-name sweep | `uat-15-a11y` |
| Money-page smokes: home, branches shell, jewelry/layaway + karat + pawn calculators | `home/branches/jewelry/karat-guide/pawn-calculator.spec` |

### Admin dashboard
| Journey | Spec |
|---|---|
| Branch email-OTP login, forced password change, forgot password | `uat-01-branch-login` |
| 8h MFA step-up (email-code form, rate limits, cancel = logout) | `uat-02-stepup-reverify` |
| Access control: deep links, role gates, token rotation | `uat-03-access-control` |
| Chat messaging core: incoming → auto-open → markRead, unread badges, reply → REST + WS delivery, typing, cross-branch guard | `uat-04-chat-messaging` |
| E2EE + media: conversation key, ciphertext-only wire (decrypt-verified), key outage fail-open, image upload → signed-URL resolve → tap-to-retry | `uat-05-chat-e2ee-media` |
| Lifecycle: chatClosed, authoritative presence pruning, ack-failure Retry, REST-500 Retry, dead realtime layer | `uat-06-chat-lifecycle` |
| Superadmin tooling: Branch Passwords outage/401 (F6/F12), Staff Management CRUD + one-time reveal, Observability, Audit | `uat-07-superadmin-tooling` |
| Analytics views, landing portal, superadmin-login surfaces, two-way role matrix, scoped audit | `uat-08-analytics-access` |
| Keyboard login, Enter-to-send (F13), accessible-name sweep | `uat-09-a11y` |

### Backend (unit, `backend/tests/`)
Auth gates, message routes, public routes, MFA/step-up, JWT keys/expiry contract, cache, backup round-trip, chat image normalizer.

## Finding registry (all fixed unless noted)

| ID | Sev | One-liner |
|---|---|---|
| F1–F6 | high→info | Login retry loop, dead MFA route, plaintext password in localStorage, attemptsLeft surfacing, cancel copy, Try-again button |
| F7 | info | MFA gate soft-passes on 5xx — deliberate, documented |
| F8 | high | Firestore cache-empty snapshots wiped live chat threads (3 hydration paths) |
| F9 | medium | Typing indicator listener bound before the socket existed — permanently dead on cold loads |
| F10 | high | DLP `pointer-events:none` made Retry/tap-to-retry unclickable for real users |
| F11 | medium | Signed-out `/super-admin-login` loads force-bounced to the branch login |
| F12 | medium | Branch Passwords showed "No branches found." during Firestore outages |
| F13 | low/a11y | No Enter-to-send in the admin composer |
| F-G1…F-G9 | high→low | Guest chat round 1 (sensitive-regex false positives, offline banner, E2EE retry downgrade, duplicate retry bubbles, chat resurrection, dialogs/a11y) |
| F-G11 | high/SEO | Every page shared the homepage og:url/title (helmet couldn't claim the static tags); prerender now bakes per-route OG |
| F-G12 | medium | `overflow-x:hidden` on html/body disabled every `position:sticky` (branches map) |
| F-G13 | info, open | Dead unrouted page files (Bills-Payment, Jewelry-Display, Privacy-Policy dupe) — pending product call |
| F-G14 | low/a11y | No Enter-to-send in the guest composer |

## Deliberate limits (not covered here)

- Live Firebase: TOTP login/enrollment, Firestore table data (Branch Passwords rows, staff-create branch dropdown, `/admin/branches` CRUD), passkey/WebAuthn ceremonies.
- Real email delivery, Electron shell behavior, socket reconnection healing (own fixes 2026-07-22), staging/live integration runs (deliberately out of scope — hermetic only).
- Chat thread history hydration (Firestore-backed; hermetically empty by design — live socket traffic carries the scenarios).

## Full verification pass

```
# backend
cd backend && npm test
# guest
cd user-frontend && npm run build && npx playwright test && npm run test:ci
# admin
cd admin-frontend && npm run build && npx playwright test && npx cross-env CI=true react-scripts test --watchAll=false
```

Suites are deterministic (`workers:1`, `retries:0`, all I/O mocked) — a flake is a bug.
