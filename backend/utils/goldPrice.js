// backend/utils/goldPrice.js
//
// Gold price history + daily movement alerts (pawnshop pricing intel).
//
// The admin header ticker shows live spot, but "did gold move enough that we
// should adjust prices today?" needs HISTORY and a DAILY CHECK:
//   • A 15-min sampler (poller in server.js) appends PHP/gram points to ONE
//     Firestore doc (goldPrice/latest) — pruned to stay a few KB forever:
//     full 15-min resolution for 48h, hourly to 7d, daily closes to 90d.
//   • First boot backfills ~45 days of daily closes from Yahoo Finance's
//     chart API (GC=F gold futures + PHP=X), so trends are useful on day one.
//     (stooq.com's CSV endpoint — the original source — now sits behind a
//     JavaScript proof-of-work wall and serves HTML to servers. GC=F tracks
//     spot within ~0.5%, fine for trend deltas; LIVE quotes stay gold-api.)
//   • The business reprices daily off the 24h movement, so the alert is the
//     1-day delta vs GOLD_ALERT_THRESHOLD_PCT (default ±2%). Every day at
//     GOLD_ALERT_TIME (default 08:15 Asia/Manila — before branches open) a
//     scheduler emails GOLD_ALERT_EMAILS (the managers) IF the move is
//     significant, giving them time to adjust loan values / retail tags.
//     Dashboards surface the same `alert` read-only — staff see that a big
//     move happened (information only); nobody has anything to click.
//
// All math/schedule/formatting helpers are pure and exported for unit tests;
// Firestore access is confined to the thin load/save wrappers, mail goes
// through utils/email.

const { db } = require("./firebase");
const { sendMail, escapeHtml } = require("./email");

const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
const YAHOO_XAU_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=45d&interval=1d";
const YAHOO_PHP_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/PHP%3DX?range=45d&interval=1d";
// Yahoo answers bare clients with 429/403; a browser-ish UA is sufficient.
const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; MagisGoldTicker/1.0)" };
const FETCH_TIMEOUT_MS = 15_000;
const GRAMS_PER_TROY_OUNCE = 31.1034768;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Retention ladder (ms window → min spacing between kept points).
const KEEP_FULL_MS = 48 * HOUR;   // every 15-min sample
const KEEP_HOURLY_MS = 7 * DAY;   // ≥1h apart
const KEEP_DAILY_MS = 90 * DAY;   // ≥20h apart (daily closes)
const BACKFILL_DAYS = 45;
const DEFAULT_THRESHOLD_PCT = 2;
const DEFAULT_ALERT_TIME = "08:15"; // HH:mm, Asia/Manila
const ALERT_TZ = "Asia/Manila";

const DOC_PATH = { collection: "goldPrice", doc: "latest" };

/** ±% that counts as "significant" — env-tunable, clamped to sanity. */
function alertThresholdPct() {
  const v = Number(process.env.GOLD_ALERT_THRESHOLD_PCT);
  return Number.isFinite(v) && v >= 0.25 && v <= 25 ? v : DEFAULT_THRESHOLD_PCT;
}

/** "a@x.com, b@y.com" → ["a@x.com","b@y.com"] (also splits on ; and whitespace). */
function parseRecipients(raw) {
  return String(raw || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Round to 2 decimals (PHP/gram working precision). */
const r2 = (n) => Math.round(n * 100) / 100;

function phpPerGram(usdPerOzt, phpPerUsd) {
  return (usdPerOzt * phpPerUsd) / GRAMS_PER_TROY_OUNCE;
}

/**
 * Thin points to the retention ladder. Input/output: [{ t, g }] ascending.
 * Newest 48h keep everything; 48h–7d ≥1h apart; 7d–90d ≥20h apart; older drop.
 */
function prunePoints(points, now = Date.now()) {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out = [];
  let lastKept = null;
  for (const p of sorted) {
    const age = now - p.t;
    if (age > KEEP_DAILY_MS) continue;
    let minGap = 0;
    if (age > KEEP_HOURLY_MS) minGap = 20 * HOUR;
    else if (age > KEEP_FULL_MS) minGap = HOUR;
    if (lastKept && p.t - lastKept.t < minGap) continue;
    out.push(p);
    lastKept = p;
  }
  return out;
}

/** Point nearest to `target`, if within `tolerance`. */
function nearestPoint(points, target, tolerance) {
  let best = null;
  for (const p of points) {
    const d = Math.abs(p.t - target);
    if (d <= tolerance && (!best || d < Math.abs(best.t - target))) best = p;
  }
  return best;
}

function pctChange(from, to) {
  return ((to - from) / from) * 100;
}

/** Downsample to at most `max` points, always keeping the newest. */
function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** The 24h movement judged against the threshold — the one business signal.
 *  null when there is no usable ~24h-ago reference (never a fabricated 0%). */
function evaluateAlert(d1, thresholdPct = DEFAULT_THRESHOLD_PCT) {
  if (!d1 || !Number.isFinite(d1.pct)) return null;
  return {
    pct: d1.pct,
    thresholdPct,
    significant: Math.abs(d1.pct) >= thresholdPct,
    direction: d1.pct >= 0 ? "up" : "down",
  };
}

/**
 * Business summary from the stored points.
 * Deltas use the nearest stored point to now-1d/7d/30d (±35% tolerance) so
 * weekend gaps and backfill granularity never produce lies — absent history
 * yields null, not a fabricated 0%.
 */
function computeSummary(points, now = Date.now(), thresholdPct = DEFAULT_THRESHOLD_PCT) {
  const usable = [...points].sort((a, b) => a.t - b.t);
  if (usable.length === 0) return null;
  const current = usable[usable.length - 1];

  const delta = (days) => {
    const period = days * DAY;
    const ref = nearestPoint(usable, now - period, period * 0.35);
    if (!ref || ref.t >= current.t) return null;
    return { pct: r2(pctChange(ref.g, current.g)), from: ref.g, fromT: ref.t };
  };
  const deltas = { d1: delta(1), d7: delta(7), d30: delta(30) };

  const weekPoints = usable.filter((p) => now - p.t <= 7 * DAY);
  const week =
    weekPoints.length > 0
      ? {
          high: r2(Math.max(...weekPoints.map((p) => p.g))),
          low: r2(Math.min(...weekPoints.map((p) => p.g))),
        }
      : null;

  return {
    current: { t: current.t, phpPerGram: r2(current.g) },
    deltas,
    week,
    sparkline: downsample(weekPoints, 40).map((p) => ({ t: p.t, g: r2(p.g) })),
    alert: evaluateAlert(deltas.d1, thresholdPct),
  };
}

// ── Daily alert schedule + email (pure) ───────────────────────────────────

/** Wall-clock date + HH:mm in Manila for a given instant. */
function manilaParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ALERT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${get("hour")}:${get("minute")}`,
  };
}

/** Due exactly once per Manila day, within the configured minute. */
function isAlertDue({ now = Date.now(), lastSentDate = null, alertTime = DEFAULT_ALERT_TIME } = {}) {
  const { date, hhmm } = manilaParts(now);
  return { due: hhmm === alertTime && date !== lastSentDate, date, hhmm };
}

const pesoFmt = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const signedPct = (p) => `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;

/** Manager-facing morning email — subject + text + html. Pure. */
function buildAlertEmail(summary, date) {
  const { current, deltas, week, alert } = summary;
  const nowStr = pesoFmt.format(current.phpPerGram);
  const dir = alert.direction === "up" ? "UP" : "DOWN";
  const guidance =
    alert.direction === "up"
      ? "Consider raising loan values / retail tags today."
      : "Consider lowering loan values / retail tags today.";
  const line = (label, d) => `${label}: ${d ? signedPct(d.pct) : "—"}`;

  const subject = `Gold alert (${date}): ${dir} ${signedPct(alert.pct)} in 24h — now ${nowStr}/g`;

  const text = [
    `Gold moved ${signedPct(alert.pct)} in the last 24 hours (threshold ±${alert.thresholdPct}%).`,
    ``,
    `Now:      ${nowStr}/g`,
    `24h ago:  ${deltas.d1 ? `${pesoFmt.format(deltas.d1.from)}/g` : "—"}`,
    line(`7 days`, deltas.d7),
    line(`30 days`, deltas.d30),
    week ? `Week range: ${pesoFmt.format(week.low)} – ${pesoFmt.format(week.high)}` : null,
    ``,
    guidance,
    ``,
    `This automated check runs daily at ${process.env.GOLD_ALERT_TIME || DEFAULT_ALERT_TIME} (Asia/Manila)`,
    `and only emails when the 24h move exceeds ±${alert.thresholdPct}%. Dashboards show the same`,
    `movement to branch staff for information only.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const color = alert.direction === "up" ? "#15803d" : "#b91c1c";
  const row = (label, value) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;">${label}</td><td style="padding:6px 0;color:#1a1a2e;font-weight:600;">${value}</td></tr>`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#1a1a2e;margin:0 0 8px;font-size:20px;">Magis Gold — Daily Price Alert</h2>
      <p style="color:#4b5563;margin:0 0 20px;">Gold moved <strong style="color:${color};">${escapeHtml(signedPct(alert.pct))}</strong> in the last 24 hours (threshold ±${escapeHtml(String(alert.thresholdPct))}%).</p>
      <div style="font-size:28px;font-weight:800;color:#1a1a2e;background:#faf8f5;border:1px solid #e5dcc8;border-radius:12px;padding:16px;text-align:center;">${escapeHtml(nowStr)}/g</div>
      <table style="margin:20px 0 0;border-collapse:collapse;font-size:14px;">
        ${row("24h ago", deltas.d1 ? `${escapeHtml(pesoFmt.format(deltas.d1.from))}/g` : "—")}
        ${row("7-day move", deltas.d7 ? escapeHtml(signedPct(deltas.d7.pct)) : "—")}
        ${row("30-day move", deltas.d30 ? escapeHtml(signedPct(deltas.d30.pct)) : "—")}
        ${week ? row("Week range", `${escapeHtml(pesoFmt.format(week.low))} – ${escapeHtml(pesoFmt.format(week.high))}`) : ""}
      </table>
      <p style="color:#1a1a2e;font-weight:600;margin:20px 0 0;">${escapeHtml(guidance)}</p>
      <p style="color:#6b7280;font-size:12px;margin:16px 0 0;line-height:1.6;">Automated daily check at ${escapeHtml(process.env.GOLD_ALERT_TIME || DEFAULT_ALERT_TIME)} (Asia/Manila); emails only when the 24h move exceeds the threshold. Branch dashboards show the same movement for information only.</p>
    </div>`;

  return { subject, text, html };
}

/**
 * Parse a Yahoo v8 chart response → [{ date, close }] (UTC dates).
 * Tolerates missing result blocks and the nulls Yahoo pads holidays with.
 */
function parseYahooChart(payload) {
  const result = payload?.chart?.result?.[0];
  const ts = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close
    : [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ date, close });
  }
  return out;
}

/**
 * Join daily XAU/USD and USD/PHP closes on date → [{ t, g }] (21:00 UTC,
 * ≈ the NY close). Only dates present in BOTH series are used.
 */
function mergeBackfill(xauRows, fxRows, days = BACKFILL_DAYS, now = Date.now()) {
  const fxByDate = new Map(fxRows.map((r) => [r.date, r.close]));
  const cutoff = now - days * DAY;
  const out = [];
  for (const row of xauRows) {
    const fx = fxByDate.get(row.date);
    if (!fx) continue;
    const t = Date.parse(`${row.date}T21:00:00Z`);
    if (!Number.isFinite(t) || t < cutoff || t > now) continue;
    out.push({ t, g: r2(phpPerGram(row.close, fx)) });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ── Firestore wrappers ───────────────────────────────────────────────────────

const docRef = () => db.collection(DOC_PATH.collection).doc(DOC_PATH.doc);

async function loadDoc() {
  const snap = await docRef().get();
  const data = snap.exists ? snap.data() : {};
  return {
    points: Array.isArray(data.points) ? data.points : [],
    alertLastSentDate: data.alertLastSentDate || null,
  };
}

async function saveDoc(fields) {
  await docRef().set(fields, { merge: true });
}

// ── Operations (poller + routes call these) ──────────────────────────────────

async function fetchSpotPhpPerGram() {
  const [goldRes, fxRes] = await Promise.all([
    fetch(GOLD_API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    fetch(FX_API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  ]);
  if (!goldRes.ok) throw new Error(`gold-api ${goldRes.status}`);
  if (!fxRes.ok) throw new Error(`er-api ${fxRes.status}`);
  const gold = await goldRes.json();
  const fx = await fxRes.json();
  const usdPerOzt = Number(gold?.price);
  const phpPerUsd = Number(fx?.rates?.PHP);
  if (!Number.isFinite(usdPerOzt) || usdPerOzt <= 0) throw new Error("bad XAU price");
  if (!Number.isFinite(phpPerUsd) || phpPerUsd <= 0) throw new Error("bad PHP rate");
  return r2(phpPerGram(usdPerOzt, phpPerUsd));
}

/** One sampler tick: append the live point (skip if the price is unchanged
 *  within 5 min — weekend flatlines shouldn't bloat the doc). */
async function sampleOnce(now = Date.now()) {
  const g = await fetchSpotPhpPerGram();
  const { points } = await loadDoc();
  const last = points[points.length - 1];
  if (last && last.g === g && now - last.t < 5 * 60 * 1000) return null;
  const next = prunePoints([...points, { t: now, g }], now);
  await saveDoc({ points: next, updatedAt: now });
  return { t: now, g };
}

/** Seed daily closes from Yahoo when history is sparse (first boot). Never
 *  overwrites live samples; purely additive for past days. Best-effort. */
async function backfillIfSparse(now = Date.now()) {
  const { points } = await loadDoc();
  const oldest = points.length ? Math.min(...points.map((p) => p.t)) : now;
  if (now - oldest > 8 * DAY) return false; // already have real history
  const opts = { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  const [xauRes, fxRes] = await Promise.all([
    fetch(YAHOO_XAU_URL, opts),
    fetch(YAHOO_PHP_URL, opts),
  ]);
  if (!xauRes.ok || !fxRes.ok) {
    throw new Error(`yahoo chart unavailable (${xauRes.status}/${fxRes.status})`);
  }
  const backfill = mergeBackfill(
    parseYahooChart(await xauRes.json()),
    parseYahooChart(await fxRes.json()),
    BACKFILL_DAYS,
    now
  );
  if (backfill.length === 0) {
    // Loudly, not silently — a source going dark (as stooq did) should be
    // visible in the logs, not discovered via a flat trend panel weeks later.
    console.warn("[gold] backfill sources returned no usable rows");
    return false;
  }
  // Live points win on any near-duplicate timestamp (±2h).
  const merged = [
    ...backfill.filter((b) => !points.some((p) => Math.abs(p.t - b.t) < 2 * HOUR)),
    ...points,
  ];
  await saveDoc({ points: prunePoints(merged, now), backfilledAt: now });
  console.log(`[gold] backfilled ${backfill.length} daily closes from yahoo`);
  return true;
}

async function getSummary(now = Date.now()) {
  const { points } = await loadDoc();
  return computeSummary(points, now, alertThresholdPct());
}

/**
 * The 08:15 check: once per Manila day, when GOLD_ALERT_EMAILS is configured
 * and the 24h move is significant, email the managers. Returns a small result
 * object so the scheduler log line explains every outcome.
 */
async function sendDailyAlertIfDue(now = Date.now()) {
  const recipients = parseRecipients(process.env.GOLD_ALERT_EMAILS);
  if (recipients.length === 0) return { sent: false, reason: "no-recipients" };
  const alertTime = process.env.GOLD_ALERT_TIME || DEFAULT_ALERT_TIME;

  // Cheap wall-clock precheck before any I/O — this runs every ~45s.
  if (manilaParts(now).hhmm !== alertTime) return { sent: false, reason: "not-due" };

  const { points, alertLastSentDate } = await loadDoc();
  const { due, date } = isAlertDue({ now, lastSentDate: alertLastSentDate, alertTime });
  if (!due) return { sent: false, reason: "already-sent" };

  const summary = computeSummary(points, now, alertThresholdPct());
  if (!summary?.alert) return { sent: false, reason: "no-history" };
  if (!summary.alert.significant) return { sent: false, reason: "below-threshold" };

  const { subject, text, html } = buildAlertEmail(summary, date);
  await sendMail({ to: recipients.join(", "), subject, text, html });
  await saveDoc({ alertLastSentDate: date });
  return { sent: true, pct: summary.alert.pct, recipients: recipients.length };
}

module.exports = {
  GRAMS_PER_TROY_OUNCE,
  DEFAULT_THRESHOLD_PCT,
  DEFAULT_ALERT_TIME,
  phpPerGram,
  prunePoints,
  nearestPoint,
  pctChange,
  downsample,
  evaluateAlert,
  computeSummary,
  parseYahooChart,
  mergeBackfill,
  parseRecipients,
  manilaParts,
  isAlertDue,
  buildAlertEmail,
  fetchSpotPhpPerGram,
  sampleOnce,
  backfillIfSparse,
  getSummary,
  sendDailyAlertIfDue,
};
