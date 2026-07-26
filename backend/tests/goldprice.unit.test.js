// Gold pricing intel — pure-math guardrails (utils/goldPrice.js).
// The sampler/routes are thin wrappers; the business truth (retention ladder,
// delta windows, drift/reprice flag, stooq parsing) lives in these helpers.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  prunePoints,
  computeSummary,
  parseStooqCsv,
  mergeBackfill,
  downsample,
  phpPerGram,
  GRAMS_PER_TROY_OUNCE,
  DEFAULT_THRESHOLD_PCT,
} = require("../utils/goldPrice");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-07-26T12:00:00Z");

describe("phpPerGram conversion", () => {
  test("divides by troy-ounce grams after FX conversion", () => {
    // Same fixture as the frontend test: 3000 USD/ozt * 58 PHP/USD.
    const g = phpPerGram(3000, 58);
    assert.ok(Math.abs(g - (3000 * 58) / GRAMS_PER_TROY_OUNCE) < 1e-9);
    assert.ok(Math.abs(g - 5594.23) < 0.01);
  });
});

describe("prunePoints retention ladder", () => {
  test("keeps 15-min resolution ≤48h, hourly to 7d, daily to 90d, drops older", () => {
    const points = [];
    // 15-min points across the last 3 hours (fresh window).
    for (let i = 0; i < 12; i++) points.push({ t: NOW - i * 15 * 60 * 1000, g: 8000 + i });
    // 15-min points at 3 days old (should thin to ~hourly).
    for (let i = 0; i < 8; i++) points.push({ t: NOW - 3 * DAY - i * 15 * 60 * 1000, g: 7900 + i });
    // hourly points at 30 days old (should thin to ~daily).
    for (let i = 0; i < 48; i++) points.push({ t: NOW - 30 * DAY - i * HOUR, g: 7800 + i });
    // ancient point far beyond retention.
    points.push({ t: NOW - 120 * DAY, g: 7000 });

    const kept = prunePoints(points, NOW);

    // All 12 fresh points survive.
    assert.equal(kept.filter((p) => NOW - p.t <= 3 * HOUR).length, 12);
    // The 8 quarter-hour points at 3d collapse to ≤2 (≥1h spacing over 1.75h span).
    assert.ok(kept.filter((p) => Math.abs(NOW - p.t - 3 * DAY) <= 3 * HOUR).length <= 2);
    // The 48 hourly points at 30d collapse to ≤3 (≥20h spacing over a 47h span).
    const oldBand = kept.filter((p) => NOW - p.t >= 29 * DAY && NOW - p.t <= 33 * DAY);
    assert.ok(oldBand.length <= 3, `expected ≤3 daily points, got ${oldBand.length}`);
    // The 120d point is gone.
    assert.equal(kept.some((p) => NOW - p.t > 91 * DAY), false);
    // Output stays ascending.
    for (let i = 1; i < kept.length; i++) assert.ok(kept[i].t > kept[i - 1].t);
  });
});

describe("computeSummary", () => {
  const series = [
    { t: NOW - 30 * DAY, g: 7600 },
    { t: NOW - 7 * DAY, g: 7800 },
    { t: NOW - 1 * DAY, g: 8000 },
    { t: NOW - 2 * HOUR, g: 8050 },
    { t: NOW, g: 8100 },
  ];

  test("deltas measure against the nearest stored point per window", () => {
    const s = computeSummary(series, null, NOW);
    assert.equal(s.current.phpPerGram, 8100);
    assert.equal(s.deltas.d1.pct, 1.25);   // 8000 → 8100
    assert.ok(Math.abs(s.deltas.d7.pct - 3.85) < 0.01);  // 7800 → 8100
    assert.ok(Math.abs(s.deltas.d30.pct - 6.58) < 0.01); // 7600 → 8100
    assert.equal(s.week.high, 8100);
    assert.equal(s.week.low, 7800);
    assert.ok(s.sparkline.length >= 3);
    assert.equal(s.drift, null);
    assert.equal(s.baseline, null);
  });

  test("missing history yields null deltas, never a fabricated 0%", () => {
    const s = computeSummary([{ t: NOW, g: 8100 }], null, NOW);
    assert.equal(s.deltas.d1, null);
    assert.equal(s.deltas.d7, null);
    assert.equal(s.deltas.d30, null);
  });

  test("empty history yields null summary", () => {
    assert.equal(computeSummary([], null, NOW), null);
  });

  test("baseline drift flags reprice at/above threshold, both directions", () => {
    const base = { phpPerGram: 8000, thresholdPct: 2, setAt: NOW - 5 * DAY };
    const up = computeSummary(series, base, NOW); // 8000 → 8100 = +1.25%
    assert.equal(up.drift.pct, 1.25);
    assert.equal(up.drift.reprice, false);

    const strong = computeSummary(
      [...series.slice(0, -1), { t: NOW, g: 8180 }], // +2.25%
      base,
      NOW
    );
    assert.equal(strong.drift.reprice, true);

    const down = computeSummary(
      [...series.slice(0, -1), { t: NOW, g: 7830 }], // −2.13%
      base,
      NOW
    );
    assert.equal(down.drift.reprice, true);
    assert.ok(down.drift.pct < 0);
  });

  test("baseline without thresholdPct falls back to the default", () => {
    const s = computeSummary(series, { phpPerGram: 8000, setAt: NOW }, NOW);
    assert.equal(s.drift.thresholdPct, DEFAULT_THRESHOLD_PCT);
  });
});

describe("stooq backfill parsing", () => {
  const XAU_CSV = [
    "Date,Open,High,Low,Close,Volume",
    "2026-07-20,4000,4010,3990,4005.5,0",
    "2026-07-21,4005,4030,4000,4020,0",
    "not,a,row",
    "2026-07-22,4020,4025,3995,4010,0",
    "",
  ].join("\n");
  const FX_CSV = [
    "Date,Open,High,Low,Close,Volume",
    "2026-07-20,61.5,61.9,61.4,61.8,0",
    "2026-07-22,61.8,62.1,61.7,62,0",
  ].join("\n");

  test("parseStooqCsv skips headers and malformed rows", () => {
    const rows = parseStooqCsv(XAU_CSV);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { date: "2026-07-20", close: 4005.5 });
  });

  test("mergeBackfill joins on date and converts to PHP/gram", () => {
    const merged = mergeBackfill(parseStooqCsv(XAU_CSV), parseStooqCsv(FX_CSV), 45, NOW);
    // 07-21 has no FX row → dropped; 07-20 and 07-22 survive.
    assert.equal(merged.length, 2);
    const expected = (4005.5 * 61.8) / GRAMS_PER_TROY_OUNCE;
    assert.ok(Math.abs(merged[0].g - expected) < 0.01);
    assert.ok(merged[0].t < merged[1].t);
  });

  test("mergeBackfill drops rows outside the window", () => {
    const old = [{ date: "2020-01-02", close: 1500 }];
    const fx = [{ date: "2020-01-02", close: 50 }];
    assert.equal(mergeBackfill(old, fx, 45, NOW).length, 0);
  });
});

describe("downsample", () => {
  test("caps length, keeps first and last", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ t: i, g: i }));
    const ds = downsample(pts, 40);
    assert.equal(ds.length, 40);
    assert.equal(ds[0].t, 0);
    assert.equal(ds[39].t, 199);
  });

  test("short series pass through untouched", () => {
    const pts = [{ t: 1, g: 1 }];
    assert.equal(downsample(pts, 40), pts);
  });
});
