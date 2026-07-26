// backend/utils/goldPrice.js
//
// Gold price history + pricing-baseline service (pawnshop pricing intel).
//
// The admin header ticker shows live spot, but "should we reprice loans and
// retail tags?" needs HISTORY and a BASELINE:
//   • A 15-min sampler (poller in server.js) appends PHP/gram points to ONE
//     Firestore doc (goldPrice/latest) — pruned to stay a few KB forever:
//     full 15-min resolution for 48h, hourly to 7d, daily closes to 90d.
//   • First boot backfills ~45 days of daily closes from stooq.com's free CSV
//     endpoints (XAU/USD + USD/PHP), so trends are useful on day one.
//   • Management records a pricing baseline ("current loan/retail prices
//     assume ₱X/g"); when spot drifts ≥ thresholdPct from it, the summary
//     flags `reprice` and the ticker turns amber (see GoldPriceTicker).
//
// All math/parsing helpers are pure and exported for unit tests; Firestore
// access is confined to the thin load/save wrappers.

const { db } = require("./firebase");

const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
const STOOQ_XAU_URL = "https://stooq.com/q/d/l/?s=xauusd&i=d";
const STOOQ_PHP_URL = "https://stooq.com/q/d/l/?s=usdphp&i=d";
const GRAMS_PER_TROY_OUNCE = 31.1034768;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Retention ladder (ms window → min spacing between kept points).
const KEEP_FULL_MS = 48 * HOUR;   // every 15-min sample
const KEEP_HOURLY_MS = 7 * DAY;   // ≥1h apart
const KEEP_DAILY_MS = 90 * DAY;   // ≥20h apart (daily closes)
const BACKFILL_DAYS = 45;
const DEFAULT_THRESHOLD_PCT = 2;

const DOC_PATH = { collection: "goldPrice", doc: "latest" };

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

/**
 * Business summary from the stored points + baseline.
 * Deltas use the nearest stored point to now-1d/7d/30d (±35% tolerance) so
 * weekend gaps and backfill granularity never produce lies — absent history
 * yields null, not a fabricated 0%.
 */
function computeSummary(points, baseline, now = Date.now()) {
  const usable = [...points].sort((a, b) => a.t - b.t);
  if (usable.length === 0) return null;
  const current = usable[usable.length - 1];

  const delta = (days) => {
    const period = days * DAY;
    const ref = nearestPoint(usable, now - period, period * 0.35);
    if (!ref || ref.t >= current.t) return null;
    return { pct: r2(pctChange(ref.g, current.g)), from: ref.g, fromT: ref.t };
  };

  const weekPoints = usable.filter((p) => now - p.t <= 7 * DAY);
  const week =
    weekPoints.length > 0
      ? {
          high: r2(Math.max(...weekPoints.map((p) => p.g))),
          low: r2(Math.min(...weekPoints.map((p) => p.g))),
        }
      : null;

  let drift = null;
  if (baseline && Number.isFinite(baseline.phpPerGram) && baseline.phpPerGram > 0) {
    const pct = r2(pctChange(baseline.phpPerGram, current.g));
    const threshold = Number.isFinite(baseline.thresholdPct)
      ? baseline.thresholdPct
      : DEFAULT_THRESHOLD_PCT;
    drift = { pct, thresholdPct: threshold, reprice: Math.abs(pct) >= threshold };
  }

  return {
    current: { t: current.t, phpPerGram: r2(current.g) },
    deltas: { d1: delta(1), d7: delta(7), d30: delta(30) },
    week,
    sparkline: downsample(weekPoints, 40).map((p) => ({ t: p.t, g: r2(p.g) })),
    baseline: baseline || null,
    drift,
  };
}

/**
 * Parse a stooq daily CSV (Date,Open,High,Low,Close,Volume) → [{ date, close }].
 * Tolerates the header row, blank lines, and malformed rows.
 */
function parseStooqCsv(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const cols = line.split(",");
    if (cols.length < 5) continue;
    const date = cols[0].trim();
    const close = Number(cols[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
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
    baseline: data.baseline || null,
  };
}

async function saveDoc(fields) {
  await docRef().set(fields, { merge: true });
}

// ── Operations (poller + routes call these) ──────────────────────────────────

async function fetchSpotPhpPerGram() {
  const [goldRes, fxRes] = await Promise.all([fetch(GOLD_API_URL), fetch(FX_API_URL)]);
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

/** Seed daily closes from stooq when history is sparse (first boot). Never
 *  overwrites live samples; purely additive for past days. Best-effort. */
async function backfillIfSparse(now = Date.now()) {
  const { points } = await loadDoc();
  const oldest = points.length ? Math.min(...points.map((p) => p.t)) : now;
  if (now - oldest > 8 * DAY) return false; // already have real history
  const [xauRes, fxRes] = await Promise.all([fetch(STOOQ_XAU_URL), fetch(STOOQ_PHP_URL)]);
  if (!xauRes.ok || !fxRes.ok) throw new Error("stooq unavailable");
  const backfill = mergeBackfill(
    parseStooqCsv(await xauRes.text()),
    parseStooqCsv(await fxRes.text()),
    BACKFILL_DAYS,
    now
  );
  if (backfill.length === 0) return false;
  // Live points win on any near-duplicate timestamp (±2h).
  const merged = [
    ...backfill.filter((b) => !points.some((p) => Math.abs(p.t - b.t) < 2 * HOUR)),
    ...points,
  ];
  await saveDoc({ points: prunePoints(merged, now), backfilledAt: now });
  console.log(`[gold] backfilled ${backfill.length} daily closes from stooq`);
  return true;
}

async function getSummary(now = Date.now()) {
  const { points, baseline } = await loadDoc();
  return computeSummary(points, baseline, now);
}

/** Record the pricing baseline (management "we repriced at ₱X/g"). */
async function setBaseline({ phpPerGram: value, thresholdPct, setBy }, now = Date.now()) {
  const { points, baseline: prev } = await loadDoc();
  const current = points.length ? points[points.length - 1].g : null;
  const g = Number.isFinite(value) && value > 0 ? r2(value) : current;
  if (!Number.isFinite(g) || g <= 0) throw new Error("no price available for baseline");
  const threshold =
    Number.isFinite(thresholdPct) && thresholdPct >= 0.5 && thresholdPct <= 15
      ? thresholdPct
      : prev?.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const baseline = { phpPerGram: g, thresholdPct: threshold, setBy: setBy || null, setAt: now };
  await saveDoc({ baseline });
  return computeSummary(points, baseline, now);
}

module.exports = {
  GRAMS_PER_TROY_OUNCE,
  DEFAULT_THRESHOLD_PCT,
  phpPerGram,
  prunePoints,
  nearestPoint,
  pctChange,
  downsample,
  computeSummary,
  parseStooqCsv,
  mergeBackfill,
  fetchSpotPhpPerGram,
  sampleOnce,
  backfillIfSparse,
  getSummary,
  setBaseline,
};
