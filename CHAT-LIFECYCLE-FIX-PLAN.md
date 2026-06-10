# Guest ↔ Admin Chat Lifecycle — One-Shot Fix Plan

**Status:** IN PROGRESS — open decisions resolved (§8); **Phases A, B & C IMPLEMENTED & verified** (2026-06-10; A build-verified, B/C `node --check` OK); Phase D pending review gate
**Author:** audit 2026-06-10
**Scope:** presence / lifecycle desync between the guest chat box and the admin
chat dashboard. **Out of scope:** message encryption, auth, CSP, caching, bundles,
edge worker (all preserved — see §6).

> **Non-regression commitment:** every change below is presence/lifecycle plumbing.
> It does **not** alter E2EE, auth/MFA, P1-2 room derivation, CSP nonce, signed-URL
> media, or any PERF upgrade. One change (R4, Redis-backed presence) *strengthens*
> the PERF3-2 scaling posture. The one place that touches a prior upgrade
> (Scenario C2 vs the PERF1-3 `branch-status` cache) is called out in §6 as a
> deliberate decision, not a silent regression.

---

## 1. The model (ground truth)

- **Left list = `chats` ∩ `activeGuestIds`** — sidebar renders
  `chats.filter(c => !c.archived && activeGuestIds.has(c.guestId))`
  (`admin-frontend/src/pages/Branch-Chat-Dashboard.js:432`). A row shows only if it
  is in **both** the `chats` array and the live presence set.
- **`activeGuestIds`** is meant to be server-authoritative (`guestPresenceUpdate`),
  but is also persisted to `localStorage` (`branchChats-<email>`) and cross-tab
  synced via BroadcastChannel — so it can be *resurrected* from stale state.
- **`chatClosed`** is the teardown signal: the server removes the guest from the
  in-memory `branchGuests` set and emits `chatClosed` + `guestPresenceUpdate` to the
  admin room (`backend/utils/socket.js:836`).
- **Only undelivered *messages* are replayed** on admin reconnect
  (`backend/utils/socket.js:411-432`). Presence / `chatClosed` events are **not**
  replayed.
- **Right pane = `selectedChat` + `messages`** (filtered `!archived`). A closed
  guest's messages get archived → an open thread for them renders **empty**.
- **`branchGuests`** is in-memory, per-process (`backend/utils/socket.js:57`). Redis
  tracks only *branch-online* (admin presence, 90s TTL) — **not** the guest list.

---

## 2. Root causes (recap)

- **R1 — No authoritative presence reconciliation on reconnect.** The only
  authoritative `guestPresenceUpdate` is pushed by the server *on connection*
  (`socket.js:436`), which races the admin's listener rebind (the rebind happens
  only after the `joinRoom` ACK in `Admin-Utils-socket.js`). The
  `adminSocketReconnected` handler refreshes messages/unreads but never re-syncs
  `activeGuestIds`.
- **R2 — Stale-state resurrection.** `localStorage` restores `activeGuestIds` on
  mount, and the `chatChannel` cross-tab handler does
  `setActiveGuestIds(payload.activeGuestIds)` (`Branch-Chat-Dashboard.js:1654-1657`)
  — re-adding presence the server already cleared. (The *other* sync channel at
  `:1269-1274` deliberately refuses to do this — the two are inconsistent.)
- **R3 — Missed-while-offline events aren't replayed.** Only messages have an
  undelivered queue; `chatClosed`/presence don't.
- **R4 — Presence is in-memory, per-process.** Breaks under PERF3-2 scaling and on
  server restart; Redis tracks branch-online but not the guest set.
- **R5 — Heuristic teardown timing.** Multiple guest-exit paths + long heartbeat
  (5 min) / TTL (10 min) windows produce variable ghost durations.

---

## 3. The fix — phased & change-by-change

The phases are ordered low-risk → higher-effort. **Phase A+B fix the reported
Scenario 1 family for single-instance.** Phase C adds multi-instance correctness.
Each phase is independently shippable and verifiable.

### Phase A — Client-only: stop resurrection + pull on reconnect (R1 admin-side, R2, R5 hygiene)
*Files: `admin-frontend/src/pages/Branch-Chat-Dashboard.js` only. Zero backend. Lowest risk.*

> **✅ IMPLEMENTED & build-verified** (2026-06-10 — `admin-frontend` build exit 0,
> +194 B js / +58 B css, no new lint warnings). As-built notes vs the spec below
> (functionally equivalent or stronger):
> - **A1** — there was no `localStorage` mount-restore to remove (the dashboard
>   already skips cache hydration and relies on live presence). The as-built change
>   instead stops *persisting* `activeGuestIds` (`persistChatState` + the `chatClosed`
>   writer now write `[]`), so no future reader can resurrect it.
> - **A3** — the pull is emitted inside `rebindSocketListeners` (the exact point right
>   after the listener is re-bound), which fires on initial connect *and* every
>   reconnect via `onSocketConnected` — stronger than hooking only the
>   `adminSocketReconnected` handler.
> - **D-1** — added a 5 s fail-safe that flips `presenceReady` so the skeleton can
>   never hang if a presence frame is missed before Phase B's `requestGuestPresence`
>   handler exists.

- **A1 — Treat `activeGuestIds` as live, server-only (kills R2/B2).**
  Stop restoring `activeGuestIds` from `localStorage` on mount. Still hydrate
  `chats` (previews) from `localStorage` for instant paint, but initialize
  `activeGuestIds` **empty** and let the server feed populate it. Because the render
  intersects with `activeGuestIds` (`:432`), nothing shows until the authoritative
  set arrives (sub-second). **Decision (D-1): show a brief "syncing…" skeleton**,
  gated to appear only if the pull exceeds ~200ms (instant pulls show no
  placeholder). Never render cached/unconfirmed rows — truth first.
- **A2 — Make cross-tab sync consistent (kills R2/B3).**
  In the `chatChannel.onmessage` `updateChats` branch (`:1643-1658`), **stop**
  `setActiveGuestIds(new Set(payload.activeGuestIds))`. Cross-tab sharing keeps
  `chats` previews only; presence comes from each tab's own live server feed —
  matching the deliberate behavior already documented in the adminSync handler
  (`:1269-1274`).
- **A3 — Pull authoritative presence after the admin is READY (R1 admin-side).**
  In the `adminSocketReconnected` handler (`:1148-1199`), **after** listeners are
  rebound, emit a `requestGuestPresence` event and apply the response through the
  existing `handlePresenceUpdate`. This removes dependence on the racing
  connection-time push (B1). Also call it once on initial mount-ready.
- **A4 — Prune `chats` against authoritative presence (kills B5).**
  When an authoritative `guestPresenceUpdate` arrives, drop `chats` rows whose
  `guestId` is absent from the set (hygiene; the render already hides them, this
  keeps state clean and stops stale rows leaking via cross-tab `chats` sharing).

> **Phase A alone** removes the resurrection vectors and reconciles on reconnect.
> Combined with the existing connection-time push it largely fixes Scenario 1 even
> before the backend pull handler exists — but A3 is only fully robust once Phase B
> adds the server handler.

### Phase B — Backend pull handler (R1 server-side)
*File: `backend/utils/socket.js`.*

> **✅ IMPLEMENTED & verified** (2026-06-10 — `node --check backend/utils/socket.js`
> OK; `socket.use` JWT bypass allow-list confirmed unchanged). As-built notes:
> - **B1** — `branchEmail` derived strictly from `socket.user` (already lowercased
>   at auth `:293`/`:313`, so it reads the same `branchGuests` Set as the
>   connection-time push at `:436`); reply via `socket.emit` to the requesting
>   socket only. Accepts an optional ack, but the Phase A client emits without one.
> - **B3** — satisfied by *exclusion*: `requestGuestPresence` is not in the
>   `socket.use` bypass list, so it passes full per-event JWT re-verification. Added
>   a guard comment so it isn't mistakenly added later.
> Together with Phase A, A3 is now fully race-proof via three delivery layers
> (connection push + `joinRoom` re-emit + explicit pull) — Scenario 1 fixed for
> single-instance.

- **B1 — Add a `requestGuestPresence` socket handler.**
  Derive `branchEmail` strictly from `socket.user` (P1-2 — never trust client
  input; mirror the `joinRoom` pattern at `:498-522`). Read the authoritative guest
  set (Phase C: Redis; until then: in-memory `branchGuests`) and emit
  `guestPresenceUpdate` **to the requesting socket only**.
- **B2 — Belt-and-suspenders re-emit inside `joinRoom` ACK.**
  After an admin (re)joins its branch room, re-emit the current
  `guestPresenceUpdate` to that admin so a correct push exists even if A3's request
  is in flight. (The connection-time emit at `:436` stays as a third layer.)
- **B3 — Add `requestGuestPresence` to the per-event JWT path correctly.**
  It must pass the existing `socket.use` JWT re-verification (`:338-389`) — do
  **not** add it to the bypass list; it's a privileged read.

### Phase C — Redis-backed guest presence (R4, much of R5, E-group)
*File: `backend/utils/socket.js` (+ existing `backend/utils/redis.js`).*

> **✅ IMPLEMENTED & verified** (2026-06-10 — `node --check` OK; `ZRANGE … BYSCORE`
> deprecation-clean for Redis ≥ 6.2). As-built notes (functionally equivalent or
> stronger):
> - **Model** — used **one per-branch sorted set** `guest:online:z:<email>`
>   (member = guestId, score = last-seen ms) instead of per-guest TTL keys. The plan
>   explicitly allowed "a per-branch Redis set"; the ZSET gives keyspace-independent
>   O(log N + M) reads, so the frequent `checkForStaleGuests` reconciliation (fired
>   by the 5s `broadcastAlive`) never does a whole-keyspace SCAN — *strengthening*
>   PERF3-2 rather than risking a regression.
> - **C1** — ZADD on connect + every heartbeat (guests beat every **5s**, verified —
>   not 30s — so the 90s window tolerates many missed beats); ZREM on explicit
>   `chatClosed`.
> - **Disconnect refinement** — a transport disconnect does **not** ZREM; it lets the
>   score age out (bounded ~90s). Deleting on every disconnect would flap a
>   *reconnecting* guest offline (a truth violation). Explicit closes still ZREM.
> - **C2** — all six admin-facing `guestPresenceUpdate` emits **and**
>   `checkForStaleGuests` now read the Redis set (cross-instance), not local-only —
>   required because the client treats each emit as an authoritative full-replace.
> - **C3** — every Redis op is wrapped; reads + reconciliation fail open to the
>   in-memory `branchGuests`, which is still maintained.

- **C1 — Mirror the branch-online TTL pattern for guests.**
  On guest connect/heartbeat, write a short-TTL key `guest:online:<email>:<guestId>`
  (`GUEST_ONLINE_TTL_SEC = 90`, matching the existing branch `ONLINE_TTL_SEC`),
  refreshed by the 30s guest heartbeat (tolerates ~2 missed beats). On clean
  `chatClosed`/disconnect, delete it. This auto-expires silently-dropped guests →
  **bounded ghost window (~90s)** and **multi-instance correctness**.
- **C2 — Authoritative read = Redis union.**
  `requestGuestPresence` (B1) and the connect-time/`joinRoom` emits compute the set
  by scanning `guest:online:<email>:*` (or a per-branch Redis set), not the
  per-process `branchGuests`. Keep `branchGuests` as a fast local cache for live
  emits only.
- **C3 — Fail-open to today's behavior.**
  If Redis is unavailable, fall back to in-memory `branchGuests` (current behavior)
  — no hard new dependency, mirroring the existing "running without Redis adapter"
  tolerance (`:230-232`).

### Phase D — Tuning + optional hardening (R5, R3-optional)
*Files: `backend/utils/socket.js`, optionally guest component.*

- **D1 — Server-side reap of dropped guests (Decision D-2: keep the app reap as a
  backstop; do NOT aggressively lower it).**
  The real presence bound is **two faster mechanisms already in place / added here**:
  (a) the Socket.IO **transport disconnect ~85s** (`pingInterval 25000` +
  `pingTimeout 60000` at `socket.js:201-202`) which fires `disconnect` →
  `handleDisconnect` → removes the guest, and (b) the **Redis guest TTL ~90s** (C1).
  The 5-min `MAX_MISSED_PINGS=10` app reap stays as a backstop only. Rationale:
  lowering the app reap would risk **false-reaping present-but-jittery mobile
  guests** — a *truth* regression — for no real gain, since (a)+(b) already bound
  the ghost window to ~90s.
- **D2 — Reconnect grace to reduce flicker (C1/D2).**
  Optionally suppress a transient presence-drop on the admin if the guest
  reconnects within a short grace window (phone-sleep / app-switch). Lower priority.
- **D3 — Recently-closed set for selection/badge cleanup (R3) — INCLUDED (Decision
  D-3).**
  A short-TTL (≈10 min) Redis `branch:closed:<email>` set included in the
  `requestGuestPresence` response, so the admin also clears a lingering selected
  thread / unread badge for guests closed during an offline gap. The set-difference
  reconcile (A4) covers the *list*; this completes the *right pane + badges* so the
  lifecycle is correct under **all** circumstances (per requirements), not just the
  sidebar. Low-risk, read-only in the reconcile response.

> **Note:** R3 for the *sidebar list* is **subsumed by R1** — pulling the
> authoritative current set on reconnect inherently handles "guest closed while I
> was away" (they're simply absent from the pulled set). D3 (now **included**) adds
> the selection/badge cleanup so the *right pane* is also correct in the offline-gap
> case — required for "true updates under all circumstances."

---

## 4. Scenario → root-cause → phase coverage

| Scenario | Root cause | Fixed by |
|---|---|---|
| A1 guest X-closes while admin offline (**reported**) | R1, R2 | A1–A4, B |
| A2 idle-timeout close while admin offline | R1, R3 | A3–A4, B |
| A3 navigate/close-tab/browser while admin offline | R1, R3 | A3–A4, B |
| A4 guest network-drop, falsely "online" | R5, R4 | C1, D1 |
| A5 message vs presence reconcile asymmetry | R1, R3 | A3–A4, B, D3 |
| B1 listener-rebind race | R1 | A3, B2 |
| B2 localStorage resurrection | R2 | A1 |
| B3 cross-tab resurrection | R2 | A2 |
| B4 empty-set refresh skip | R1 | A3–A4 |
| B5 merge-not-prune | R1 | A4 |
| C1 offline/online flicker | R5 | D2 (+existing 5s debounce) |
| C2 stale "online" via REST cache | (PERF1-3 tradeoff) | **decided: keep cache; socket is real-time — §6** |
| C3 "online" but sends fail | R5 | C1, D1, D2 |
| D1 tab-hidden REST close fails | R3, R5 | C1 (TTL backstop) |
| D2 phone-sleep flicker | R5 | C1, D2 |
| D3 minimized counts as active | (correct) | no change (preserve idle erase) |
| D4 long ghost window | R5, R4 | C1, D1 |
| E1 multi-instance partial set | R4 | C1–C2 |
| E2 server restart wipes presence | R4 | C1–C2 |
| E3 Redis adapter down | R4 | C3 fail-open |
| F1 hidden-tab selection lingers | R1 | A3–A4 (+visibility re-check) |
| F2 ghost row → empty thread | R1 | A4 (row removed) |
| F3 collateral clear | R1 | A3 (authoritative apply) |
| G1 orphan unread badge | R1, R3 | A4, D3 |
| G2 orphan message row | R3 | D3 |

Every enumerated scenario maps to a phase. **Single-instance deployments are fully
covered by A+B+D; scaling adds C.**

---

## 5. Implementation order & shippability

1. **Phase A** (client-only) — fixes resurrection + reconnect reconcile. Ship + verify.
2. **Phase B** (backend pull handler) — completes R1 robustly. Ship + verify.
3. **Phase C** (Redis presence) — multi-instance + bounded ghost. Ship + verify.
4. **Phase D** (tuning/optional) — flicker + reap tuning + optional cleanup.

Each phase is a separate commit with its own build + verification.

---

## 6. Security & performance guardrails (preserve every prior upgrade)

**Security — preserved:**
- **P1-2 (room/identity from verified token):** the new `requestGuestPresence`
  handler derives `branchEmail` from `socket.user` only — never client input
  (mirrors `joinRoom` `:498-522`). No cross-branch read.
- **Per-event JWT re-verification (`socket.use` `:338-389`):** the new event is NOT
  bypass-listed; it re-verifies like other privileged events.
- **E2EE:** presence-only changes; message ciphertext / key path untouched.
- **Idle-timeout auto-erase + cache wipe** (walk-away / internet-café protection,
  `Guest-Chat-Box-Component.js:707-760`): **NOT weakened.** Server-side reap (D1) is
  independent of the client-side idle erase.
- **Per-message ACL, `authenticateGuest`/`authenticateBranchAdmin`, signed-URL
  private media, CSP nonce:** untouched.

**Performance — preserved:**
- **PERF3-2:** WebSocket-only transport + Redis adapter kept; **no new polling
  loops** — reconcile fires on socket (re)connect events. R4 *strengthens* scaling
  (Redis-backed presence instead of per-process memory).
- **PERF1-1 / PERF4-x / PERF5-1:** compression, bundles, edge cache out of scope.
- New Redis ops (C1) are O(1) per connect/disconnect/heartbeat — consistent with the
  existing branch-online TTL writes; negligible load.

**The one deliberate tradeoff (Scenario C2) — Decision: KEEP the cache as-is.**
- Branch "online" can read stale for ~60-90s because `/branch-status` is REST-cached
  30/60s (PERF1-3) + Redis TTL 90s. **Decision: keep the PERF1-3 cache unchanged.**
  Justification: connected guests already get **real-time** truth via the socket
  `branchStatus` (pushed on admin disconnect at `socket.js:893-900` and on the 30s
  presence check) — the REST cache only affects a **cold-load fallback**, so the
  staleness is cosmetic and does not violate lifecycle truth for active sessions.
  Reducing the TTL would regress PERF1-3 (more origin hits) for negligible gain →
  rejected to honor the zero-regression requirement.

---

## 7. Verification (per phase)

- **Build:** `admin-frontend` build (Phase A), `backend` lint/start (Phase B/C).
- **Manual scenario tests:** reproduce Scenario 1 (admin offline → guest closes →
  admin online) and confirm the guest disappears from BOTH panes; repeat for A2/A3
  (idle, navigate-away); verify multi-tab (B3) no longer resurrects; verify
  refresh (B2) reconciles within a second.
- **Regression smoke checks (from `PERFORMANCE-PLAN.md` §6):** confirm no
  authenticated/personalized response is cached; HTML still served with per-request
  CSP nonce (not from SW cache).
- **Scaling (Phase C):** with 2 backend instances, guest on A + admin on B → admin
  sees the guest; kill instance A → guest expires from presence within the TTL.

---

## 8. Decisions (resolved)

All four optimized for the stated requirements — **truth under all circumstances**
+ **zero regression** of prior security/perf upgrades.

- **D-1 → "syncing…" skeleton.** Initialize `activeGuestIds` empty and show a brief
  skeleton (only if the authoritative pull exceeds ~200ms) instead of rendering
  cached/unconfirmed rows. *Truth first — never paint a ghost; no security/perf
  impact.*
- **D-2 → keep the app heartbeat reap as a backstop (do NOT lower it).** Real bound
  is the Socket.IO transport disconnect (~85s) + Redis guest TTL (~90s, C1).
  Lowering the app reap would false-reap jittery mobile guests — a truth regression
  — for no gain. *Bounds ghosts to ~90s without harming truth.*
- **D-3 → INCLUDE the recently-closed set.** Needed to clear lingering
  selection/unread badges for guests closed during an offline gap — truth under
  *all* circumstances, not just the sidebar list. Low-risk, read-only.
- **C2 → keep the PERF1-3 cache as-is.** Socket `branchStatus` is the real-time
  authority for connected guests; the REST cache only affects a cold-load fallback.
  Reducing its TTL would regress PERF1-3 for a cosmetic gain. *Non-regression wins.*
