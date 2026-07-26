# UAT Report — Admin Dashboard (Branch Login, MFA Step-up, Access Control, Chat Dashboard)

**Date:** 2026-07-23 · chat-dashboard round (megaplan Phase A) 2026-07-26 · superadmin-tooling round (Phase C) 2026-07-26 · a11y round (Phase D) 2026-07-26 · **Method:** automated exploratory testing + UX friction audit against the production bundle (Playwright, all network mocked; the chat round adds a fake socket.io server at the engine.io v4 protocol level playing the GUEST side — see `e2e/fixtures.js`) · **Result: 49/49 scenarios passing** after fixes. Unit suite 73/73. Cross-suite index: `../UAT-MEGAPLAN.md`.

Run locally: `npm run build && npm run e2e` (from `admin-frontend/`).

---

## 1. Workflows validated (multi-page)

| # | Journey | Outcome |
|---|---------|---------|
| W1 | Branch email-OTP login: credentials → emailed code (auto-submit on 6th digit) → `/admin/chats` | PASS — never touches Firebase/staff endpoints |
| W1b | Forced password change interstitial → change → dashboard | PASS |
| W1c | Forgot password: request → neutral confirmation → reset-code view | PASS |
| W2 | 8h MFA re-verification for a branch email-OTP account: modal shows EMAIL-code form (not password+authenticator), auto-requests a code via `/api/branch/stepup/request`, verifies via `/verify`, dashboard resumes | PASS — regression trap confirms `/api/staff/stepup/*` is never called |
| W2b | Step-up cancel → full logout → protected pages stay locked | PASS |
| W3 | Deep link to `/admin/chats` with no session → bounced to login | PASS |
| W3b | Branch admin deep-linking a superadmin page (`/admin/branch-passwords`) → redirected, no content leak | PASS |
| W3c | Expired token: silent rotation succeeds → stays signed in; rotation fails → clean logout | PASS |
| W4 | Chat messaging core: incoming guest message → sidebar row + auto-open + `markRead`; second guest → unread badge → select clears + notifies; reply → optimistic → REST persist → WS emit to `guest-<id>` → delivered; typing both directions (room-scoped); cross-branch message hard-ignored | PASS (after F8, F9) |
| W5 | E2EE + media: conversation key on open → "Encrypted (AES-256-GCM)" → replies leave as `{ciphertext,iv}` on BOTH channels (REST + WS, verified by decrypting with the conversation key); encrypted guest messages decrypt live; key outage → honest fallback banner + plaintext `e2ee:false`; image reply → preview → multipart → private path → signed-URL render; resolve outage → bounded retries → tap-to-retry recovers | PASS (after F10) |
| W6 | Lifecycle: `chatClosed` removes conversation + resets pane; authoritative `guestPresenceUpdate` prunes ghost rows/badges/open thread (incl. empty set); WS ack failure → failed + Retry → recovers without duplicates; reply REST 500 → failed + Retry → single bubble; dead realtime layer → shell stays usable, no crash | PASS (after F8, F10) |
| W7 | Superadmin tooling: Branch Passwords Firestore-outage error + working Try again (F6 trap) and 401 → sign-in-again; Staff Management list/reset-password (one-time reveal incl. email-failure notice)/2FA toggle/enable·disable/revoke-devices/delete-with-confirm against `/api/admin/staff/*`; Observability snapshot; Audit & Compliance summary + events table | PASS (after F12) |
| W8 | Analytics (branch-admin view) renders mocked metrics + degrades honestly on 500; landing portal; superadmin-login domain validation + graceful auth-outage error; role matrix extended — superadmin ⇎ branchadmin can never open each other's tools; audit as branch admin = scoped "Activity History" | PASS (after F11) |
| W9 | Keyboard a11y (Phase D): login operable by keyboard alone (Tab order + Enter submit → readable failure); composer Enter-to-send; no nameless buttons on the dashboard | PASS (after F13) |

## 2. Exploratory probes (failure paths)

- **Wrong password** → generic anti-enumeration error, form stays usable. PASS (after fix F1).
- **Wrong OTP at login** → readable error, input cleared, retry succeeds. PASS.
- **Wrong step-up code** → readable error, recovery works. PASS.
- **Login rate-limited (429)** → "Too many attempts" surfaced. PASS.
- **Disabled account (403)** → admin-contact message surfaced. PASS.
- **Step-up code rate-limited (429)** → wait message + resend countdown honoring server `retryAfterSec`. PASS.
- **Resend cooldown** → button disabled with live countdown. PASS.
- **Outage simulation** — Firebase, reCAPTCHA, and socket.io hard-blocked in every test: login and the MFA gate still work end-to-end (they are backend-only). Dashboard shell renders without client Firestore.

## 3. UX friction findings

### Fixed during this UAT
- **F1 (high, fixed)** — `Branch-Unified-Login`: when reCAPTCHA fails to load (adblock, captive portal, outage), a wrong-password attempt fell into an **infinite silent retry loop** — no error, no spinner, nothing. Now bounded at ~5s with "Authentication service unavailable…".
- **F2 (medium, fixed)** — `MFASessionModal` "MFA Not Set Up" state sent users to `/profile?setupMFA=true` — **a route that does not exist** (dead-end button). Now returns to the login page, where enrollment actually happens.
- **F3 (high, fixed)** — `Branch-Unified-Login` stored the **plaintext password** in `localStorage` (`testBranchAdminPassword`, legacy autofill) on every Firebase login — readable via DevTools on shared branch PCs. Write removed; existing values are actively cleaned up on next login.

### Fixed in follow-up (2026-07-24)
- **F4 (low, fixed)** — Wrong OTP now shows the backend's `attemptsLeft` ("Incorrect code. 4 attempts left before you need a new code.") in BOTH the login OTP view and the step-up modal. Backend already returned it on all five verify paths; the UI just ignored it. Covered by e2e assertions.
- **F5 (low, fixed)** — Step-up modal's bare "Cancel" is now "Cancel & sign out" with helper copy ("Cancelling ends your session — you'll need to sign in again."). The full-logout behavior itself is unchanged (right call for DPA compliance).
- **F6 (info, fixed)** — Branch Passwords error banner now includes a **Try again** button that re-runs `loadAll` in place.

### Fixed in the chat-dashboard round (2026-07-26)
- **F8 (high, fixed)** — `Branch-Chat-Dashboard`: three thread-hydration paths (`fetchMessages`, the selected-chat effect's blind `setMessages([])`, and the cross-tab `updateChats` rehydration) **replaced** the open thread with the Firestore snapshot. When Firestore is unreachable, `getDocs` resolves from the (empty) local cache instead of rejecting — so the exact degraded mode the dashboard is designed to survive (socket alive, Firestore down) **wiped live messages off the screen**, including the very message that auto-opened the thread. Hydration now merges by `id`/`tempId` and the blind wipe is gone (manual switches still clear via `handleChatSelect`).
- **F9 (medium, fixed)** — the "Guest is typing…" listener bound once on mount — before `connectSocket` creates the socket on a cold load — so it attached to nothing and the indicator stayed dead for the whole session. Now rebinds whenever the socket (re)connects (same pattern as the `chatClosed` binder).
- **F10 (high, fixed)** — the DLP stylesheet's blanket `pointer-events: none` on message bubbles made every in-bubble control decorative: **"Retry" on a failed reply and the media "tap to retry" could never be clicked**. Buttons (like links before them) now accept pointer events; selection/copy/screenshot protection is unchanged.

### Fixed in the superadmin-tooling round (2026-07-26, Phase C)
- **F11 (medium, fixed)** — `AuthContext.hydrate()`'s no-session logout path whitelisted only `/`: a signed-out user DIRECTLY loading `/super-admin-login` (or `/staff-login`) was force-redirected to `/branch-admin-login` — **superadmins couldn't reach their own login page by URL or refresh**. All public login routes are whitelisted now; deep-link bouncing for `/admin/*` is unchanged.
- **F12 (medium, fixed)** — Branch Passwords: with Firestore unreachable, `getDocs` resolves an **empty cache-only snapshot** instead of rejecting, so the page showed a misleading "No branches found." with no error and no Try again (the F8 mechanism, different symptom). A cache-only empty snapshot is now treated as the outage it is → error banner + working Try again.

### Fixed in the a11y round (2026-07-26, Phase D)
- **F13 (low, a11y, fixed)** — the reply composer had **no Enter-to-send**: staff had to click (or Tab to) the Send button for every reply. Enter now sends under exactly the Send button's guard; Shift+Enter stays reserved. Mirrors the guest-side F-G14.

### Remaining notes (deliberate, no action)
- **F7 (info)** — MFA gate soft-passes on backend 5xx (documented design decision in `Branch-Chat-Dashboard.js`) — a deliberate availability-over-strictness trade-off; flagged so it stays a conscious choice.

## 4. Coverage limits

- Firebase-TOTP login/enrollment (QR path) and the superadmin Branch Passwords **table interactions** require live Firebase; covered by backend tests (`backend/tests/`, 81/81) and manual smoke, not by this suite.
- Real email delivery, Socket.IO reconnection, and Electron-shell behavior are out of scope here (socket healing has its own fixes from 2026-07-22).
- **Thread history** is Firestore-backed and stays empty hermetically — chat scenarios drive everything through live socket traffic (which is also what proves the F8 degraded mode). Cross-tab BroadcastChannel sync is exercised only incidentally.
- **Phase C limits:** live-Firestore table data (Branch Passwords rows, Staff Management's branch dropdown → create-staff flow), the real Firebase superadmin login + TOTP ceremony, passkey/WebAuthn ceremonies, and `/admin/branches` CRUD (Firestore-backed forms) stay manual/backend-covered. `interestrate.js` is an unrouted dead file (logged, pending product call).

## 5. Chat-suite notes (Phase A)

- `fixtures.js` hosts the fake socket.io server (engine.io v4 over `page.routeWebSocket`, server-initiated heartbeats, emit acks in the app's `{success:…}` envelope). Tests push `receiveMessage` / `typing` / `guestPresenceUpdate` / `chatClosed` as the guest side and assert on everything the dashboard emits (`joinRoom`, `confirmReady`, `markRead`, `typing`, `sendMessage`).
- Node-side AES-256-GCM helpers mirror `src/utils/e2eeCrypto.js`; the mocked `/api/messages/conversation-key/:guestId` hands both sides the same key, so tests decrypt the dashboard's wire output and encrypt fake guest messages.
- Media: mocked multipart `/api/messages/reply` returns a private storage `path`; `/api/messages/admin-media/:id` resolves it to a same-origin PNG — exercising the full resolve → retry → render ladder.
