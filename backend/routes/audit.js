// backend/routes/audit.js
//
// Read API for the chat audit & compliance dashboard. Mirrors the bounded,
// type-correct query pattern used by routes/analytics.js:
//   - the `ts` field is an ISO-8601 string (sorts chronologically),
//   - every query is time-bounded (default lookback when no range supplied),
//   - the document scan is hard-capped (AUDIT_MAX_DOCS) with a `truncated` flag,
//   - accurate windowed totals come from a count() aggregation (no doc transfer).
//
// Role scoping (set by authenticateAuditViewer):
//   - super-admin  → sees all branches and ALL categories.
//   - branch-admin → forced to their OWN branchEmail and restricted to the
//                    branch-visible categories (chat + access).
//
// All endpoints are READ-ONLY. The only write is the meta-audit event recorded
// when a CSV export is performed (a higher-risk, compliance-relevant action).

const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const authenticateAuditViewer = require("../middlewares/authenticateAuditViewer");
const {
  recordAuditEvent,
  auditContextFromReq,
  COLLECTION,
  CATEGORIES,
  SEVERITIES,
  OUTCOMES,
  ACTIONS,
  BRANCH_VISIBLE_CATEGORIES,
  RETENTION_DAYS,
} = require("../utils/auditLog");

const isDev = process.env.NODE_ENV === "development";
const devLog = (...a) => { if (isDev) console.log(...a); };

const AUDIT_MAX_DOCS = Math.max(parseInt(process.env.AUDIT_MAX_DOCS, 10) || 5000, 1);
const AUDIT_DEFAULT_DAYS = Math.max(parseInt(process.env.AUDIT_DEFAULT_DAYS, 10) || 90, 1);
const AUDIT_PAGE_DEFAULT = Math.min(Math.max(parseInt(process.env.AUDIT_PAGE_DEFAULT, 10) || 100, 1), 500);
const AUDIT_EXPORT_MAX = Math.max(parseInt(process.env.AUDIT_EXPORT_MAX, 10) || 10000, 1);

// ── helpers ────────────────────────────────────────────────────────────────
function toIsoBound(value, endOfDay = false) {
  if (value == null || value === "") return null;
  if (endOfDay && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const dt = new Date(`${value}T23:59:59.999Z`);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function resolveWindow(startDate, endDate) {
  let startIso = toIsoBound(startDate);
  let endIso = toIsoBound(endDate, true);
  if (!startIso || !endIso) {
    const endMs = endIso ? new Date(endIso).getTime() : Date.now();
    const startMs = startIso ? new Date(startIso).getTime() : endMs - AUDIT_DEFAULT_DAYS * 86400000;
    startIso = startIso || new Date(startMs).toISOString();
    endIso = endIso || new Date(endMs).toISOString();
  }
  return { startIso, endIso };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// Build a scoped, time-bounded base query (server-side: ts range + ONE indexed
// equality) plus the residual predicates to apply in Node. Keeping a single
// server-side equality avoids a combinatorial index explosion while staying
// bounded; the residual filters run over the capped scan (branch-admins only
// ever scan their own branch's slice).
function buildScopedQuery(req) {
  const scope = req.audit;
  const {
    category, action, severity, outcome,
    guestId, actorEmail, branchEmail, q, startDate, endDate,
  } = req.query;
  const { startIso, endIso } = resolveWindow(startDate, endDate);

  let effectiveBranchEmail = null;
  let allowedCategories = null; // null = all categories
  if (!scope.isSuper) {
    effectiveBranchEmail = scope.branchEmail;
    allowedCategories = BRANCH_VISIBLE_CATEGORIES;
  } else if (branchEmail) {
    effectiveBranchEmail = String(branchEmail).toLowerCase();
  }

  let qy = db
    .collection(COLLECTION)
    .where("ts", ">=", startIso)
    .where("ts", "<=", endIso);

  let usedEquality = null;
  if (effectiveBranchEmail) {
    qy = qy.where("branchEmail", "==", effectiveBranchEmail);
    usedEquality = "branchEmail";
  } else if (scope.isSuper && category && CATEGORIES.includes(category)) {
    qy = qy.where("category", "==", category);
    usedEquality = "category";
  }

  qy = qy.orderBy("ts", "desc");

  const requestedCategory = category && CATEGORIES.includes(category) ? category : null;
  const post = {
    // category handled server-side only when usedEquality === 'category'
    category: usedEquality === "category" ? null : requestedCategory,
    allowedCategories,
    action: action || null,
    severity: SEVERITIES.includes(severity) ? severity : null,
    outcome: OUTCOMES.includes(outcome) ? outcome : null,
    guestId: guestId || null,
    actorEmail: actorEmail ? String(actorEmail).toLowerCase() : null,
    q: q ? String(q).toLowerCase() : null,
  };

  return { qy, post, window: { start: startIso, end: endIso }, effectiveBranchEmail };
}

function applyPostFilters(docs, post) {
  return docs.filter((d) => {
    if (post.allowedCategories && !post.allowedCategories.includes(d.category)) return false;
    if (post.category && d.category !== post.category) return false;
    if (post.action && d.action !== post.action) return false;
    if (post.severity && d.severity !== post.severity) return false;
    if (post.outcome && d.outcome !== post.outcome) return false;
    if (post.guestId && (d.target?.guestId || null) !== post.guestId) return false;
    if (post.actorEmail && (d.actor?.email || "") !== post.actorEmail) return false;
    if (post.q) {
      const hay = JSON.stringify({
        action: d.action, actor: d.actor, target: d.target,
        branchEmail: d.branchEmail, meta: d.meta, context: { country: d.context?.country },
      }).toLowerCase();
      if (!hay.includes(post.q)) return false;
    }
    return true;
  });
}

function serializeEvent(d) {
  return {
    id: d.id,
    ts: d.ts,
    category: d.category,
    action: d.action,
    severity: d.severity,
    outcome: d.outcome,
    actor: d.actor || null,
    target: d.target || null,
    branchEmail: d.branchEmail || null,
    context: d.context || null,
    meta: d.meta || {},
  };
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pickFilters(query) {
  const keys = ["category", "action", "severity", "outcome", "branchEmail", "guestId", "actorEmail", "q", "startDate", "endDate"];
  const out = {};
  keys.forEach((k) => { if (query[k]) out[k] = String(query[k]).slice(0, 128); });
  return out;
}

// ── GET /api/audit/meta ──────────────────────────────────────────────────────
// Filter-dropdown metadata + the caller's effective scope.
router.get("/meta", authenticateAuditViewer, (req, res) => {
  const isSuper = req.audit.isSuper;
  res.json({
    scope: { isSuper, role: req.audit.role, branchEmail: req.audit.branchEmail || null },
    categories: isSuper ? CATEGORIES : BRANCH_VISIBLE_CATEGORIES,
    severities: SEVERITIES,
    outcomes: OUTCOMES,
    actions: Object.values(ACTIONS),
    retentionDays: RETENTION_DAYS,
    defaultLookbackDays: AUDIT_DEFAULT_DAYS,
  });
});

// ── GET /api/audit/events ────────────────────────────────────────────────────
// Paginated event list. Cursor = `before` (ts string) → returns older events.
router.get("/events", authenticateAuditViewer, async (req, res) => {
  try {
    const { qy, post, window } = buildScopedQuery(req);
    const limit = clampInt(req.query.limit, AUDIT_PAGE_DEFAULT, 1, 500);

    let scanQuery = qy;
    if (req.query.before) scanQuery = scanQuery.startAfter(String(req.query.before));

    // Over-scan a bounded amount so Node-side residual filters can still fill a
    // page; capped by AUDIT_MAX_DOCS.
    const scanLimit = Math.min(AUDIT_MAX_DOCS, limit * 8 + 50);
    const snap = await scanQuery.limit(scanLimit).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const filtered = applyPostFilters(docs, post);
    const page = filtered.slice(0, limit);

    const moreInScan = filtered.length > limit;
    const scanExhausted = snap.size < scanLimit;
    const hasMore = moreInScan || !scanExhausted;
    const nextCursor = hasMore && page.length ? page[page.length - 1].ts : null;

    let total = null;
    try { total = (await qy.count().get()).data().count; } catch (e) { devLog("[AUDIT] count() failed:", e.message); }

    res.json({
      events: page.map(serializeEvent),
      count: page.length,
      total,
      truncated: snap.size >= scanLimit,
      nextCursor,
      window,
      scope: { isSuper: req.audit.isSuper, branchEmail: req.audit.branchEmail || null },
    });
  } catch (error) {
    console.error("[AUDIT] Error fetching events:", error.message);
    res.status(500).json({ error: "Failed to fetch audit events" });
  }
});

// ── GET /api/audit/summary ───────────────────────────────────────────────────
// Aggregated counts for the compliance overview (cards + trend chart).
router.get("/summary", authenticateAuditViewer, async (req, res) => {
  try {
    const { qy, post, window } = buildScopedQuery(req);
    const snap = await qy.limit(AUDIT_MAX_DOCS).get();
    const docs = snap.docs.map((d) => d.data());
    const filtered = applyPostFilters(docs, post);

    const byCategory = {}, bySeverity = {}, byOutcome = {}, byAction = {}, byDay = {};
    filtered.forEach((d) => {
      byCategory[d.category] = (byCategory[d.category] || 0) + 1;
      bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
      byOutcome[d.outcome] = (byOutcome[d.outcome] || 0) + 1;
      byAction[d.action] = (byAction[d.action] || 0) + 1;
      const day = (d.ts || "").slice(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + 1;
    });

    const topActions = Object.entries(byAction)
      .sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([action, count]) => ({ action, count }));
    const series = Object.entries(byDay)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    let total = null;
    try { total = (await qy.count().get()).data().count; } catch (e) { devLog("[AUDIT] count() failed:", e.message); }

    res.json({
      total,
      matched: filtered.length,
      truncated: snap.size >= AUDIT_MAX_DOCS,
      byCategory, bySeverity, byOutcome, topActions, series,
      window,
      scope: { isSuper: req.audit.isSuper, branchEmail: req.audit.branchEmail || null },
    });
  } catch (error) {
    console.error("[AUDIT] Error building summary:", error.message);
    res.status(500).json({ error: "Failed to build audit summary" });
  }
});

// ── GET /api/audit/export.csv ────────────────────────────────────────────────
// Compliance export. Capped at AUDIT_EXPORT_MAX rows. The export itself is
// recorded as an access.audit.exported event (best-effort).
router.get("/export.csv", authenticateAuditViewer, async (req, res) => {
  try {
    const { qy, post } = buildScopedQuery(req);
    const snap = await qy.limit(AUDIT_EXPORT_MAX).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const filtered = applyPostFilters(docs, post);

    const header = [
      "ts", "category", "action", "severity", "outcome",
      "actorType", "actorEmail", "actorRole", "branchEmail",
      "targetType", "targetId", "guestId", "ip", "country", "meta",
    ];
    const lines = [header.join(",")];
    filtered.forEach((d) => {
      lines.push([
        d.ts, d.category, d.action, d.severity, d.outcome,
        d.actor?.type, d.actor?.email, d.actor?.role, d.branchEmail,
        d.target?.type, d.target?.id, d.target?.guestId,
        d.context?.ip, d.context?.country, JSON.stringify(d.meta || {}),
      ].map(csvCell).join(","));
    });
    const csv = lines.join("\r\n");

    // Meta-audit: who exported what (best-effort, non-blocking).
    recordAuditEvent({
      category: "access",
      action: ACTIONS.ACCESS_AUDIT_EXPORTED,
      severity: "notice",
      actor: { type: req.audit.role, id: req.audit.id, email: req.audit.email, role: req.audit.role, branchEmail: req.audit.branchEmail },
      branchEmail: req.audit.branchEmail || (req.query.branchEmail ? String(req.query.branchEmail).toLowerCase() : null),
      context: auditContextFromReq(req),
      meta: { count: filtered.length, truncated: snap.size >= AUDIT_EXPORT_MAX, filters: pickFilters(req.query) },
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-export-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csv);
  } catch (error) {
    console.error("[AUDIT] Error exporting CSV:", error.message);
    res.status(500).json({ error: "Failed to export audit log" });
  }
});

module.exports = router;
