// Gold pricing intel — pure-math guardrails (utils/goldPrice.js).
// The sampler/routes are thin wrappers; the business truth (retention ladder,
// delta windows, 24h alert, Manila schedule, email content, yahoo parsing)
// lives in these helpers.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  prunePoints,
  computeSummary,
  evaluateAlert,
  parseYahooChart,
  mergeBackfill,
  parseRecipients,
  manilaParts,
  isAlertDue,
  buildAlertEmail,
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
    const s = computeSummary(series, NOW);
    assert.equal(s.current.phpPerGram, 8100);
    assert.equal(s.deltas.d1.pct, 1.25);   // 8000 → 8100
    assert.ok(Math.abs(s.deltas.d7.pct - 3.85) < 0.01);  // 7800 → 8100
    assert.ok(Math.abs(s.deltas.d30.pct - 6.58) < 0.01); // 7600 → 8100
    assert.equal(s.week.high, 8100);
    assert.equal(s.week.low, 7800);
    assert.ok(s.sparkline.length >= 3);
  });

  test("missing history yields null deltas AND null alert, never a fabricated 0%", () => {
    const s = computeSummary([{ t: NOW, g: 8100 }], NOW);
    assert.equal(s.deltas.d1, null);
    assert.equal(s.deltas.d7, null);
    assert.equal(s.deltas.d30, null);
    assert.equal(s.alert, null);
  });

  test("empty history yields null summary", () => {
    assert.equal(computeSummary([], NOW), null);
  });

  test("24h alert flags significant moves at/above threshold, both directions", () => {
    // +1.25% under the default ±2% → present but not significant.
    const calm = computeSummary(series, NOW);
    assert.equal(calm.alert.pct, 1.25);
    assert.equal(calm.alert.significant, false);
    assert.equal(calm.alert.direction, "up");
    assert.equal(calm.alert.thresholdPct, DEFAULT_THRESHOLD_PCT);

    // 8000 → 8180 = +2.25% → significant up.
    const up = computeSummary([...series.slice(0, -1), { t: NOW, g: 8180 }], NOW);
    assert.equal(up.alert.significant, true);
    assert.equal(up.alert.direction, "up");

    // 8000 → 7830 = −2.13% → significant down.
    const down = computeSummary([...series.slice(0, -1), { t: NOW, g: 7830 }], NOW);
    assert.equal(down.alert.significant, true);
    assert.equal(down.alert.direction, "down");

    // Custom threshold: same +2.25% move is calm at ±5%.
    const wide = computeSummary([...series.slice(0, -1), { t: NOW, g: 8180 }], NOW, 5);
    assert.equal(wide.alert.significant, false);
    assert.equal(wide.alert.thresholdPct, 5);
  });

  test("evaluateAlert: null d1 → null (no reference, no alert)", () => {
    assert.equal(evaluateAlert(null, 2), null);
    assert.equal(evaluateAlert({ pct: NaN }, 2), null);
  });
});

describe("daily alert schedule (Asia/Manila)", () => {
  test("manilaParts converts UTC instants to Manila wall clock (UTC+8)", () => {
    // 2026-07-26T00:15Z = 08:15 in Manila, same date.
    const p = manilaParts(Date.parse("2026-07-26T00:15:00Z"));
    assert.deepEqual(p, { date: "2026-07-26", hhmm: "08:15" });
    // 2026-07-26T20:15Z = 04:15 NEXT day in Manila.
    const q = manilaParts(Date.parse("2026-07-26T20:15:00Z"));
    assert.deepEqual(q, { date: "2026-07-27", hhmm: "04:15" });
  });

  test("isAlertDue: only within the configured minute, once per Manila day", () => {
    const at0815 = Date.parse("2026-07-26T00:15:30Z"); // 08:15 Manila
    assert.equal(isAlertDue({ now: at0815, lastSentDate: null }).due, true);
    // Already sent today → not due (restart-safe idempotence).
    assert.equal(isAlertDue({ now: at0815, lastSentDate: "2026-07-26" }).due, false);
    // Sent yesterday → due again.
    assert.equal(isAlertDue({ now: at0815, lastSentDate: "2026-07-25" }).due, true);
    // Wrong minute → never due.
    const at0816 = Date.parse("2026-07-26T00:16:10Z");
    assert.equal(isAlertDue({ now: at0816, lastSentDate: null }).due, false);
    // Custom time honored.
    assert.equal(
      isAlertDue({ now: at0816, lastSentDate: null, alertTime: "08:16" }).due,
      true
    );
  });

  test("parseRecipients: splits, trims, drops non-addresses", () => {
    assert.deepEqual(
      parseRecipients(" boss@magis.ph, owner@magis.ph ;also@x.com  junk "),
      ["boss@magis.ph", "owner@magis.ph", "also@x.com"]
    );
    assert.deepEqual(parseRecipients(""), []);
    assert.deepEqual(parseRecipients(undefined), []);
  });
});

describe("buildAlertEmail", () => {
  const series = [
    { t: NOW - 30 * DAY, g: 7600 },
    { t: NOW - 7 * DAY, g: 7800 },
    { t: NOW - 1 * DAY, g: 8000 },
    { t: NOW, g: 8180 }, // +2.25% in 24h → significant
  ];

  test("subject + bodies carry direction, magnitude, price, and guidance", () => {
    const summary = computeSummary(series, NOW);
    const { subject, text, html } = buildAlertEmail(summary, "2026-07-26");
    assert.match(subject, /UP \+2\.25% in 24h/);
    assert.match(subject, /2026-07-26/);
    assert.match(subject, /8,180\.00/);
    assert.match(text, /raising loan values/);
    assert.match(text, /information only/);
    assert.match(html, /\+2\.25%/);
    assert.match(html, /8,180\.00/);
    assert.match(html, /raising loan values/);
  });

  test("a significant DROP flips direction and guidance", () => {
    const summary = computeSummary(
      [...series.slice(0, -1), { t: NOW, g: 7820 }], // −2.25%
      NOW
    );
    const { subject, text } = buildAlertEmail(summary, "2026-07-26");
    assert.match(subject, /DOWN -2\.25% in 24h/);
    assert.match(text, /lowering loan values/);
  });
});

describe("yahoo backfill parsing", () => {
  // Shape of https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF —
  // timestamps in seconds, closes padded with null on holidays.
  const yahoo = (rows) => ({
    chart: {
      result: [
        {
          timestamp: rows.map(([date]) => Date.parse(`${date}T14:30:00Z`) / 1000),
          indicators: { quote: [{ close: rows.map(([, close]) => close) }] },
        },
      ],
    },
  });
  const XAU = yahoo([
    ["2026-07-20", 4005.5],
    ["2026-07-21", 4020],
    ["2026-07-22", 4010],
    ["2026-07-23", null], // holiday padding — must be skipped
  ]);
  const FX = yahoo([
    ["2026-07-20", 61.8],
    ["2026-07-22", 62],
  ]);

  test("parseYahooChart pairs timestamps with closes, skips null pads", () => {
    const rows = parseYahooChart(XAU);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { date: "2026-07-20", close: 4005.5 });
  });

  test("parseYahooChart tolerates empty/malformed payloads", () => {
    assert.deepEqual(parseYahooChart(null), []);
    assert.deepEqual(parseYahooChart({}), []);
    assert.deepEqual(parseYahooChart({ chart: { result: [{}] } }), []);
  });

  test("mergeBackfill joins on date and converts to PHP/gram", () => {
    const merged = mergeBackfill(parseYahooChart(XAU), parseYahooChart(FX), 45, NOW);
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
