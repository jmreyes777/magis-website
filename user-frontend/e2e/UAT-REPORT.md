# UAT Report — Guest Website (Support Chat, Contact, Privacy Surfaces)

**Date:** 2026-07-24 · **Method:** automated exploratory testing + UX friction audit against the production bundle (Playwright; API mocked with real response shapes, socket.io faked at the engine.io protocol level so tests can act as the branch side — see `e2e/uat-fixtures.js`) · **Result: 15/15 UAT scenarios passing** (22/22 with the TST3 smoke suite) after fixes + follow-ups. Unit suite 86/86.

Run locally: `npm run build && npm run e2e` (from `user-frontend/`).

---

## 1. Workflows validated (multi-page / multi-step)

| # | Journey | Outcome |
|---|---------|---------|
| W1 | Contact Us → "Chat with Support" → `/api/guest/init` → socket connect → room join → send → optimistic bubble → REST persist → WS delivered ack → live staff reply renders | PASS |
| W2 | Staff typing signals: "Staff is typing…" appears and clears (sender-filtered to the branch) | PASS |
| W3 | E2EE: conversation-key handshake → outgoing wire carries `{ciphertext, iv}` + `e2ee:true` (plaintext never leaves the page), guest still sees own plaintext, encrypted staff reply decrypts live | PASS |
| W4 | Sensitive-data pre-flight: card number → masked "Security Review" interstitial (nothing sent) → Confirm & Send → sent once | PASS |
| W5 | Failed send → failed bubble with Retry → backend recovers → retry delivers, no duplicate bubbles | PASS (after F-G7) |
| W6 | Offline branch: composer disabled + "Branch is currently offline" → live `branchStatus` presence flip re-enables composer | PASS |
| W7 | Contact form: validate → submit → inline success banner (no alert) → form cleared | PASS |
| W8 | Privacy notice (zero-click) links to `/privacy-policy`, minimizes/restores via accessible buttons; "Contact branch" button opens/closes its modal | PASS |
| W9 | Close chat: in-app confirm (cancel keeps chatting) → `chatClosed` to the branch → box unmounts → `chatOpen` cleared (no resurrection) | PASS (after F-G9) |
| W10 | Delivery ack lost after REST save → bubble shows "Sent · delivery unconfirmed" (no false failure, no Retry) | PASS (F-G2) |

## 2. Exploratory probes (failure paths)

- **Realtime layer dead** (socket refused): offline banner "You are currently offline…" + composer locked — no silent limbo. PASS (after fix F-G3).
- **`/api/guest/init` 500** → readable "Failed to start chat. Please try again." and the same button works once the backend recovers — no reload needed. PASS.
- **Conversation-key service down** → chat **fails open to plaintext** with an honest `e2ee:false` on the wire. Availability-over-privacy is the documented trade-off; flagged for product sign-off below.
- **Guest token expires mid-chat** → 401 → silent refresh → automatic resend succeeds; the guest never sees an error. PASS.
- **Third-party outage baseline**: Turnstile, Firebase, Facebook, fonts and maps are blocked in every test; all journeys above still complete (Turnstile gives up after 3s and `guest/init` proceeds with a null token — backend policy decides).

## 3. UX friction findings

### Fixed during this UAT (app code)

- **F-G1 (high, fixed)** — `Guest-Chat-Box-Component` sensitive-data detection: the pawn-ticket regex alternation included bare `p`/`pawn`/`sangla` prefixes with an *optional* separator, so ordinary words — "please", "pickup", "pawnshop" — triggered the scary Security Review interstitial (and masking mangled them to `[PAWNTICKET-REDACTED]`). Most real messages contain a p-word; this interrupted normal conversation constantly. The identifier now requires a digit (real ticket refs do), in both detection and masking.
- **F-G3 (high, fixed)** — `User-Utils-socket`: `connect_error` never notified connection subscribers, and the chat starts optimistic (`isConnected=true`). If the socket *never* connected, the guest got a live-looking composer whose every message ended "Failed to send" — no offline banner, ever. `connect_error` now notifies offline, engaging the banner and composer guard.
- **F-G6 (medium, privacy, fixed)** — retrying a failed message sent **plaintext** (REST body and socket emit) even when the E2EE channel was established — a silent encryption downgrade invisible to the guest. Retries now encrypt under the same rules as the live send path (including showing local plaintext, never the echoed ciphertext).
- **F-G7 (low, fixed)** — every retry appended a fresh bubble and left the old failed one (with its own Retry button) in the thread — after one flaky send + retry the guest saw the message twice, once marked failed. The stale failed bubble (same `clientMessageId`) is now replaced in place.
- **F-G9 (low, fixed)** — `chatOpen` survived an explicit X-close (`disconnectSocket(false, "manual")` only clears it for tab-close), so the Branches page could auto-resurrect a conversation the guest had deliberately ended. The close flow now drops the flag (guest identity is kept — session reuse for a *new* chat is intended).

### Fixed in follow-up (2026-07-24, same day)

- **F-G2 (medium, fixed)** — a message that persisted via REST but whose WS delivery ack failed was marked **"Failed to send"** with a Retry — even though the branch already had it (the backend broadcasts to the branch room on REST save). Both WS-catch paths now mark it **`unconfirmed`**, rendered as a quiet "Sent · delivery unconfirmed" note — no false alarm, no duplicate-risking Retry. Covered by a dedicated spec (`wsAckFails` fixture).
- **F-G4 (low, fixed)** — all native blocking dialogs replaced: contact-form success is an inline auto-dismissing status banner; chat close and chat switch use the new accessible `Guest-Confirm-Dialog` (focus management, Escape, labelled dialog role); failed chat-open on the Branches page is an inline dismissible alert banner. Specs carry regression traps asserting **no** `window.alert`/`confirm` fires.
- **F-G5 (low, fixed)** — the composer button that opens the "Contact Branch" modal is now titled/labelled **"Contact branch"** (was "Download and send chat transcript to branch" — a download that never existed).
- **F-G8 (low, a11y, fixed)** — the privacy notice's minimize (`×`) and restore ("Privacy Policy") toggles are now real `<button>`s with `aria-label`s ("Hide/Show privacy notice") — keyboard-reachable and announced.
- **Token persistence (fixed)** — the in-chat 401 recovery now persists the token returned by `/api/guest/refresh-token` to session/local storage before retrying, instead of silently reusing the stale header token and relying on the cookie.

### Recommendations (open)

- **Product sign-off wanted** — conversation-key outage fails open to plaintext (messages keep flowing, `e2ee:false`). If policy prefers fail-closed, the composer should lock with an explanation instead.

## 4. Suite notes

- `uat-fixtures.js` fakes socket.io at the **engine.io v4 protocol level** via `page.routeWebSocket` (open packet, namespace ack, server-initiated heartbeats, emit acks in the app's `{success:…}` envelope) — tests can push `receiveMessage` / `typing` / `branchStatus` as the branch, and assert everything the app emits.
- Node-side AES-256-GCM helpers mirror `src/utils/e2eeCrypto.js`, so tests decrypt what the page sends and encrypt staff replies with the same conversation key.
- Pages are prerendered: interactions gate on **React hydration** (`__reactFiber$` on the target element) — clicking earlier is a silent no-op and was the suite's main flake source.
- `workers: 1` on purpose: concurrent chromium instances starved hydration/handshake windows into misfired clicks (measured: serial 14/14, 2–4 workers variable). Whole suite ≈ 1 min.
