# SEC26 Wave 1 — Ownership / Authorization Matrix

Companion to `authz.contract.test.js`. Every authed surface, its owning
identity, where the check lives, and which suite proves it.

Legend: ✅ = hermetic contract test (`authz.contract.test.js` / `http.authgates.test.js`) ·
🔥 = Firestore-emulator suite (A01-4 rules tests) · ⚡ = socket suite (Wave 1 fixes A01-2/3)

## REST surface

| Route | Identity | Owned object | Check location | Proof |
|---|---|---|---|---|
| `POST /api/messages/send` | guest | own `guestId` | `ensureGuestOwns` (claim vs body, pre-data) | ✅ |
| `POST /api/messages/reply` | branchadmin | own `branchEmail` | `ensureBranchOwns` (claim vs body, pre-data) | ✅ |
| `GET /api/messages/history/:guestId` | branchadmin | own branch's conversation | Firestore query scoped `branchId == req.branchId` | ✅ role gate · 🔥 data scope |
| `GET /api/messages/all` | superadmin | everything (role-bound) | `authenticateSuperAdmin` role gate | ✅ |
| `POST /api/messages/conversation-key` | guest | own conversation key | key derived from `req.user` only (no client input) | ✅ role gate |
| `GET /api/messages/conversation-key/:guestId` | branchadmin + MFA | own branch's key | `getOrCreateConversationKey(req.branchEmail, …)` scoping | ✅ role gate · 🔥 |
| `GET /api/messages/media/:id` | guest | own message media | doc fetch → `guestId` compare (`messages.js:1031`) | 🔥 (data-dependent) |
| `GET /api/messages/admin-media/:id` | branchadmin + MFA | own branch's media | doc fetch → `branchEmail` compare (`messages.js:1054`) | ✅ role gate · 🔥 |
| `PATCH /api/messages/mark-seen/:id` | branchadmin | own branch's message | doc fetch → branch compare | 🔥 |
| `PATCH /api/messages/mark-seen-by-guest/:id` | guest | own message | doc fetch → normalized `guestId` compare | 🔥 |
| `GET /api/analytics/*` (branch) | branchadmin | own branch aggregates | queries scoped to `req.branchEmail` (A01-1 fix) | ✅ role gate · 🔥 |
| `GET /api/analytics/branch-performance` | superadmin | cross-branch | role gate | ✅ |
| `GET /api/audit/*` | audit viewer | role-scoped window | `authenticateAuditViewer` | ✅ (`http.authgates`) |
| `GET/POST /api/push/*` | branchadmin | own subscriptions | `endpointDocId` + `branchEmail` compare (`push.js:78`) | ✅ role gate + fail-closed suite |
| `POST /api/guest/csat` | guest | own conversation-day | identity from token, idempotency key server-derived | ✅ role gate (CHATUX2 suite) |
| `POST /api/backup/run` | superadmin / obs key | n/a | dual-auth gate | ✅ (`http.authgates`) |

## Socket surface (utils/socket.js — A01-2/3 fixes, Wave 1 of OWASP plan)

| Event | Identity | Check | Proof |
|---|---|---|---|
| `sendMessage` | guest | token claims only (never client `guestId`) | ⚡ |
| `markSeen` | branchadmin | branch-room membership | ⚡ |
| room joins | both | JWT-auth'd socket + server-derived room names | ⚡ |

## Deliberately unauthenticated (public by design)

`/api/guest/init` (Turnstile + IP limits) · `/api/site-config/*` (cached public
config) · `/api/gold/*` (public ticker) · `/api/facebook/*` (cached, IP-limited)
· `/api/rum`, `/api/client-errors` (beacons, IP-limited, log-only) · `/health`.

## Known non-hermetic gaps (tracked, not silent)

- Media/mark-seen object-compare paths need a live Firestore doc — covered by
  the emulator rules suite (A01-4), not reproducible in the hermetic harness.
- Socket event proofs live in the socket integration path (requires a
  socket.io client + Redis-less adapter) — see TESTING-MEGAPLAN for the
  harness; Wave 4 of this plan adds the load-shaped variant.

## CHAT-PARK gate (`CHAT_ENABLED`)

When `CHAT_ENABLED` is unset/false (the default), the public guest↔branch live
chat is parked — a gate, not a removal:

- `503` + `{ code: "CHAT_DISABLED" }` (`Cache-Control: no-store`), answered
  BEFORE auth/rate-limiters on: all of `/api/guest/*` (init, refresh-token,
  force-close, csat, contact), and the guest side of `/api/messages/*`
  (`POST /start`, `POST /send`, `POST /conversation-key`, `GET /media/:id`,
  `PATCH /mark-seen-by-guest/:id`).
- `GET /api/branch-status/all` and `GET /api/branch-status` answer `200` with
  everyone offline (`chatEnabled: false`) — no Firestore/Redis read.
- Guest Socket.IO handshakes (fallback JWT with `role:"user"` + `guestId`) are
  refused with `ChatDisabled`.
- Staff/admin routes (`/reply`, `/history/:guestId`, `/all`, `/mark-seen/:id`,
  `/conversation-key/:guestId`, `/admin-media/:id`) are NOT gated, and admin
  sockets still connect.
- `POST /api/contact` (contact form) is not chat — never gated.

Proof: `http.chatDisabled.test.js`.
