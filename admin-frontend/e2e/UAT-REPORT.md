# UAT Report — Admin Dashboard (Branch Login, MFA Step-up, Access Control)

**Date:** 2026-07-23 · **Method:** automated exploratory testing + UX friction audit against the production bundle (Playwright, all network mocked — see `e2e/fixtures.js`) · **Result: 18/18 scenarios passing** after fixes.

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

### Remaining notes (deliberate, no action)
- **F7 (info)** — MFA gate soft-passes on backend 5xx (documented design decision in `Branch-Chat-Dashboard.js`) — a deliberate availability-over-strictness trade-off; flagged so it stays a conscious choice.

## 4. Coverage limits

- Firebase-TOTP login/enrollment (QR path) and the superadmin Branch Passwords **table interactions** require live Firebase; covered by backend tests (`backend/tests/`, 81/81) and manual smoke, not by this suite.
- Real email delivery, Socket.IO reconnection, and Electron-shell behavior are out of scope here (socket healing has its own fixes from 2026-07-22).
