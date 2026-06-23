# Chat Audit & Compliance Dashboard

**Status:** Implemented · **Type:** New feature (additive, zero-regression)
**Commit:** `1fb746d` — _Add chat audit & compliance dashboard (append-only audit trail)_
**Scope:** Long-term monitoring + RA 10173 (Philippine Data Privacy Act) compliance, centered on the live-chat function.

---

## 1) Objective

Provide a durable, **append-only audit trail** and an admin **dashboard** that records *who did what, when* across the chat system, so the business can:

- **Monitor** chat operations and access over time.
- **Demonstrate compliance** (RA 10173 — accountability, access logging, breach-readiness).
- **Protect all stakeholders** — guests, branch staff, and the company — with a tamper-resistant, PII-minimized record.

Built **on top of the existing stack** (Firebase/Firestore, the `analytics.js` bounded-query pattern, the `superadmin`/`branchadmin` role model, Socket.IO) — every change is additive; no existing endpoint behavior changed.

---

## 2) Architecture overview

```
            write path (best-effort, never throws)                read path (auth + scoped)
  ┌───────────────┐   recordAuditEvent()   ┌────────────┐   GET /api/audit/*   ┌──────────────────┐
  │ guest.js      │ ─────────────────────► │            │ ◄─────────────────── │ Audit Dashboard  │
  │ socket.js     │                        │ auditLogs  │                      │ (/admin/audit)   │
  │ messages.js   │                        │ (Firestore │   authenticateAudit  │  - super-admin   │
  │ geoSecurity.js│                        │  collection)│      Viewer          │  - branch self   │
  │ branchAuth.js │                        │            │                      └──────────────────┘
  │ staffAuth.js  │                        └────────────┘
  │ analytics.js  │                         client access DENIED in firestore.rules
  └───────────────┘                         (Admin SDK only)
```

- **Writer:** `backend/utils/auditLog.js` — `recordAuditEvent()` is best-effort and **never throws**, so instrumentation can never break a chat/auth flow. Called fire-and-forget from hot paths.
- **Storage:** new Firestore collection `auditLogs`. **No client access** — denied in `firestore.rules`; only the backend Admin SDK writes/reads it.
- **Read API:** `backend/routes/audit.js` behind `backend/middlewares/authenticateAuditViewer.js`, mounted at `/api/audit`.
- **Dashboard:** `admin-frontend/src/pages/Audit-Dashboard-Page.js` at `/admin/audit`.

---

## 3) Data model — `auditLogs` document

| Field | Type | Notes |
|-------|------|-------|
| `ts` | ISO-8601 string | Event time; sorts chronologically (same approach as `messages.timestamp`). |
| `tsMs` | number | Epoch ms (convenience). |
| `category` | string | `chat` · `access` · `auth` · `admin` · `security`. |
| `action` | string | Canonical action (see catalog), e.g. `chat.closed`. |
| `severity` | string | `info` · `notice` · `warning` · `critical`. |
| `outcome` | string | `success` · `failure` · `blocked`. |
| `actor` | map | `{ type, id, email, branchEmail, role }`. `type` ∈ guest/branchadmin/superadmin/staff/system. |
| `target` | map | `{ type, id, guestId }` — what was acted on. |
| `branchEmail` | string\|null | Denormalized for indexed branch-scoped reads. |
| `context` | map | `{ ip, userAgent, sessionId, country }` (from edge-forwarded headers). |
| `meta` | map | Action-specific, **sanitized** (see §8). |
| `expireAt` | timestamp | `ts + AUDIT_RETENTION_DAYS`; drives the optional Firestore TTL policy. |

---

## 4) Access model

The reader (`authenticateAuditViewer`) accepts **either** a super-admin or branch-admin session and normalizes scope onto `req.audit`. The read API enforces:

| Viewer | Branches visible | Categories visible | Notes |
|--------|------------------|--------------------|-------|
| **Super-admin** | All | All (`chat, access, auth, admin, security`) | Central compliance view; can filter by branch/category. |
| **Branch-admin** | **Own branch only** (forced server-side) | **`chat` + `access` only** | Self-service chat-compliance view; auth/admin/security stay super-admin-only. |

Entry points: branch admins → **Audit Log** tab in `AdminNavigation`; super-admins → **Audit & Compliance Log** button on the Branches page. The route (`/admin/audit`) is open to any authenticated admin; the **backend is the authority** on scoping.

---

## 5) Event catalog

Categories → actions. "Emitted" = wired in this release; "Reserved" = defined in the `ACTIONS` catalog for forward-compatibility (no code change needed to start emitting).

### chat
| Action | Emitted | Where | Severity |
|--------|:------:|-------|----------|
| `chat.session.start` | ✅ | `guest.js` `/init` | info |
| `chat.transcript.emailed` | ✅ | `guest.js` `/contact` (guest email masked) | notice |
| `chat.closed` | ✅ | `socket.js` guest `chatClosed` + `guest.js` `/force-close` | info |
| `chat.sensitive_detected` | ✅ | `messages.js` `logSensitiveMessage` (pattern **types** only) | warning |
| `chat.branch.online` / `chat.branch.offline` | ✅ | `socket.js` connect / disconnect (first/last admin tab) | info |
| `chat.guest.join` / `chat.admin.join` / `chat.archived` / `chat.transcript.requested` / `chat.rate_limited` | Reserved | — | — |

### access (DPA data-access logging)
| Action | Emitted | Where | Severity |
|--------|:------:|-------|----------|
| `access.analytics.viewed` | ✅ | `analytics.js` conversation-summary | info |
| `access.audit.exported` | ✅ | `audit.js` `/export.csv` (meta-audit) | notice |
| `access.conversation.viewed` / `access.audit.viewed` | Reserved | — | — |

### auth
| Action | Emitted | Where | Severity |
|--------|:------:|-------|----------|
| `auth.login.success` | ✅ | `branchAuth.js` + `staffAuth.js` | notice |
| `auth.login.failure` | ✅ | `branchAuth.js` + `staffAuth.js` (bad password) | warning |
| `auth.account.locked` | ✅ | `branchAuth.js` + `staffAuth.js` | warning |
| `auth.otp.issued` | ✅ | `branchAuth.js` + `staffAuth.js` | info |
| `auth.otp.failed` | ✅ | `branchAuth.js` + `staffAuth.js` | warning |
| `auth.password.changed` | ✅ | `branchAuth.js` `/change-password` | notice |
| `auth.password.reset` | ✅ | `branchAuth.js` `/reset` | notice |
| `auth.trusted_device.*` / `auth.mfa.*` / `auth.logout` / `auth.otp.verified` | Reserved | — | — |

### admin (governance)
| Action | Emitted | Where | Severity |
|--------|:------:|-------|----------|
| `admin.branch_password.set` | ✅ | `branchAuth.js` `/admin/set-password` (super-admin) | notice |
| `admin.staff.*` / `admin.branch.*` / `admin.claims.assigned` | Reserved | — | — |

### security
| Action | Emitted | Where | Severity |
|--------|:------:|-------|----------|
| `security.geo_anomaly` | ✅ | `geoSecurity.js` `logGeoAnomaly` (bridged) | critical (enforce) / warning (monitor) |
| `security.edge_auth.blocked` | Reserved | — | — |

> **Design note — message volume:** individual chat messages are **not** audited per-message (they already live in the `messages` collection and `analytics`). The audit trail records *lifecycle, access, and security* events, avoiding any write-amplification on the chat hot path.

---

## 6) API reference — `/api/audit`

All endpoints require an admin session (`authenticateAuditViewer`) and apply the §4 scoping. Queries are **time-bounded**, **doc-capped** (`AUDIT_MAX_DOCS`), and report a `truncated` flag; accurate windowed totals come from a `count()` aggregation (mirrors `analytics.js`).

| Endpoint | Purpose | Key params |
|----------|---------|-----------|
| `GET /meta` | Filter options + caller scope (categories, severities, outcomes, actions, retentionDays). | — |
| `GET /events` | Paginated event list (newest first). | `startDate,endDate,category,severity,outcome,branchEmail,guestId,actorEmail,q,limit,before` |
| `GET /summary` | Aggregates: counts by category/severity/outcome, top actions, per-day series. | (same filters) |
| `GET /export.csv` | CSV export (capped at `AUDIT_EXPORT_MAX`); records an `access.audit.exported` event. | (same filters) |

Pagination is **cursor-based** (`before` = last `ts`), so "Load older events" walks back through time.

---

## 7) Frontend dashboard

`admin-frontend/src/pages/Audit-Dashboard-Page.js` (lazy-loaded, route `/admin/audit`):

- **Scope banner** (all-branches vs own-branch) + retention note.
- **Date range** (`DateRangePicker`, presets week/month/quarter).
- **Filters:** category, severity, outcome, search (action/actor/guestId/country), and branch (super-admin only).
- **Summary cards:** total events, critical/warning, chat vs access, security/auth (or data-access for branch view).
- **Trend chart** (recharts) — daily event volume.
- **Events table** — time, category, action, severity, outcome, actor, branch (super-admin), target, details; colored badges; **"Load older events"** cursor pagination.
- **Export CSV** — current filters, auth-fetched blob download.

Wiring: `App.js` route, `AdminNavigation` "Audit Log" tab, and an "Audit & Compliance Log" button on the super-admin Branches page.

---

## 8) PII minimization & compliance (RA 10173)

- **Never stored:** message content, passwords, OTP codes, tokens, media — the writer drops a denylist of sensitive keys defensively.
- **Masked:** guest emails (`jo***@example.com`); admin/staff emails are retained as operational identity for security accountability.
- **Pattern types only:** sensitive-data detection logs *which kinds* of PII were detected (e.g. `email`, `phone`), never the values.
- **Tamper resistance:** append-only; no client read/write path (rules deny); writes via Admin SDK only.
- **Accountability:** exports are themselves audited (`access.audit.exported`).

---

## 9) Retention

- Each event stores `expireAt = ts + AUDIT_RETENTION_DAYS` (default **365**).
- Enable a **Firestore TTL policy** on `auditLogs.expireAt` (Firebase console → Firestore → TTL) to auto-delete expired events. No compute/cron required.
- Tunable via env (see §11).

---

## 10) Zero-regression measures & verification

- **Additive only:** new collection, route, middleware, page; existing handlers only gained fire-and-forget `recordAuditEvent()` calls.
- **Never throws / non-blocking:** the writer swallows all errors; instrumentation is not awaited on hot paths.
- **Noise guards:** branch online/offline log only on the true offline↔online transition (not every reconnect/tab).
- **No client surface:** `auditLogs` denied in `firestore.rules`.
- **Verified:** `node --check` passes on all 11 touched backend files; `admin-frontend` `npm run build` **succeeds** (warnings only, matching existing code).

---

## 11) Deployment / rollout

**Required** for branch-admin views (and super-admin category filter) to work — they use new composite indexes:

```bash
firebase deploy --only firestore:indexes,firestore:rules
```

Indexes added (`firestore.indexes.json`): `auditLogs(branchEmail ASC, ts DESC)` and `auditLogs(category ASC, ts DESC)`. The super-admin default (unfiltered) view uses the automatic single-field `ts` index and works without the composite deploy.

**Optional:** enable the TTL policy on `auditLogs.expireAt` (§9).

**Env (all optional, safe defaults — see `backend/backend.env.example`):**

| Var | Default | Purpose |
|-----|---------|---------|
| `AUDIT_COLLECTION` | `auditLogs` | Collection name. |
| `AUDIT_RETENTION_DAYS` | `365` | `expireAt` horizon for TTL. |
| `AUDIT_MAX_DOCS` | `5000` | Per-query scan cap. |
| `AUDIT_DEFAULT_DAYS` | `90` | Default lookback when no range. |
| `AUDIT_PAGE_DEFAULT` | `100` | Events page size. |
| `AUDIT_EXPORT_MAX` | `10000` | CSV row cap. |

> The `auditLogs` collection is created automatically on the first write — no manual setup needed for logging to begin.

---

## 12) Operations / runbook

- **Investigate a chat issue:** open `/admin/audit`, set the date range, filter `category=chat` (+ search a `guestId`) to see session start → close → archive, plus any `chat.sensitive_detected`.
- **Review access (DPA request):** filter `category=access` to see who viewed analytics / exported data.
- **Security review (super-admin):** filter `category=security` (geo anomalies) or `category=auth` `outcome=failure` for failed logins / lockouts.
- **Compliance export:** apply filters → **Export CSV** (the export is itself logged).

---

## 13) File manifest

**New**
- `backend/utils/auditLog.js` — writer, action catalog, sanitizer, retention.
- `backend/middlewares/authenticateAuditViewer.js` — combined super/branch auth → `req.audit`.
- `backend/routes/audit.js` — `/events`, `/summary`, `/export.csv`, `/meta`.
- `admin-frontend/src/pages/Audit-Dashboard-Page.js` — dashboard UI.
- `CHAT-AUDIT-DASHBOARD.md` — this document.

**Modified (additive)**
- `backend/server.js` — mount `/api/audit`.
- `firestore.rules` — deny client access to `auditLogs`.
- `firestore.indexes.json` — 2 composite indexes.
- `backend/routes/{guest,messages,branchAuth,staffAuth,analytics}.js`, `backend/utils/{socket,geoSecurity}.js` — instrumentation.
- `backend/backend.env.example` — `AUDIT_*` config.
- `admin-frontend/src/App.js`, `admin-frontend/src/components/AdminNavigation-Component.js`, `admin-frontend/src/pages/Admin-Page-BranchesList-with-Add-Edit-Delete-buttons.js` — route + nav + entry point.

---

## 14) Deferred / future work

- **Staff-account governance** (`staffAdmin.js`): `admin.staff.created/updated/deleted`.
- **Conversation open/export logging** from the chat dashboard (`access.conversation.viewed`) — needs a small client ping since those reads are client-side Firestore.
- **Send rate-limit events** (`chat.rate_limited`) in `socket.js`.
- **Branch CRUD + claims** governance (`admin.branch.*`, `admin.claims.assigned`).
- All actions above are already defined in the `ACTIONS` catalog — wiring them is purely additive.
