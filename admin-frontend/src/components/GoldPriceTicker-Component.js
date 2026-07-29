// Live gold price watch for the admin header (pawnshop daily working number).
//
// Sources — both free, no API key, CORS-open:
//   • XAU spot (USD/troy oz): https://api.gold-api.com/price/XAU  (polled 60s)
//   • USD→PHP rate:           https://open.er-api.com/v6/latest/USD (refreshed
//     every 6h — the source itself updates ~daily)
//   • Trend + 24h alert:      our backend /api/gold/summary (15-min sampler
//     history, see backend/utils/goldPrice.js) — polled every 5 min.
//
// Display: PHP per GRAM (what branches actually quote) with ▲/▼ vs the
// previous poll, a Δtoday chip, and a live "Updated Xs ago" indicator.
// Clicking the chip opens a trend panel: 7-day sparkline, 1/7/30-day deltas,
// PHP/ozt + FX, and week high/low. When the backend flags a significant 24h
// move (summary.alert — same threshold that drives the daily 08:15 manager
// email, see backend/utils/goldPrice.js) the chip turns amber/red with an
// ALERT tag. Strictly INFORMATION-ONLY on every dashboard: managers get the
// actionable email; staff just see that prices may change today. No controls.
// Keeps the last good price on transient failures (marked stale), pauses
// polling while the tab is hidden, and cleans up all timers/requests on
// unmount.
import React, { useCallback, useEffect, useRef, useState } from "react";

const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
const GOLD_POLL_MS = 60 * 1000;
const FX_REFRESH_MS = 6 * 60 * 60 * 1000;
const RELATIVE_TICK_MS = 10 * 1000;
const SUMMARY_POLL_MS = 5 * 60 * 1000;
export const GRAMS_PER_TROY_OUNCE = 31.1034768;

const phpPerGramFmt = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const phpPerOztFmt = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

// Spot gold trades Sun 6:00pm → Fri 5:00pm US Eastern (with tiny daily pauses
// we ignore). During the weekend gap the feed legitimately freezes at Friday's
// close — label it so branches don't mistake a quiet ticker for a broken one.
// Intl handles the EST/EDT switch for us.
export function isGoldMarketClosed(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get("weekday");
  const hour = Number(get("hour"));
  if (weekday === "Sat") return true;
  if (weekday === "Fri" && hour >= 17) return true;
  if (weekday === "Sun" && hour < 18) return true;
  return false;
}

export function formatUpdatedAgo(updatedAt, now = Date.now()) {
  if (!updatedAt) return "";
  const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

// "+1.25%" / "−0.80%" / "0.00%" — explicit sign, real minus glyph.
export function fmtSignedPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const v = Math.abs(pct).toFixed(2);
  if (pct > 0) return `+${v}%`;
  if (pct < 0) return `−${v}%`;
  return `${v}%`;
}

// Map [{t,g}] onto an SVG polyline "x,y x,y …" (y grows downward). Flat
// series draw a midline instead of dividing by zero.
export function sparklinePoints(points, w = 132, h = 36, pad = 3) {
  if (!Array.isArray(points) || points.length < 2) return "";
  const ts = points.map((p) => p.t);
  const gs = points.map((p) => p.g);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const g0 = Math.min(...gs);
  const g1 = Math.max(...gs);
  const spanT = t1 - t0 || 1;
  const spanG = g1 - g0;
  return points
    .map((p) => {
      const x = pad + ((p.t - t0) / spanT) * (w - 2 * pad);
      const y = spanG === 0 ? h / 2 : pad + (1 - (p.g - g0) / spanG) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// Admin-side session token: branch admin/staff first (chat dashboard), super
// admin as fallback (both are accepted by /api/gold).
export function getAdminToken() {
  return (
    sessionStorage.getItem("branchAdminToken") ||
    localStorage.getItem("branchAdminToken") ||
    sessionStorage.getItem("superAdminToken") ||
    null
  );
}

export default function GoldPriceTicker() {
  const [usdPerOzt, setUsdPerOzt] = useState(null);
  const [phpPerUsd, setPhpPerUsd] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [direction, setDirection] = useState(null); // "up" | "down" | null
  const [isStale, setIsStale] = useState(false);
  const [flash, setFlash] = useState(false);
  // Trend intel from our backend (history + 24h alert). null until first load.
  const [summary, setSummary] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Re-render ticker so "Xs ago" stays honest between polls.
  const [, setRelativeTick] = useState(0);

  const prevPriceRef = useRef(null);
  const flashTimerRef = useRef(null);
  const abortRef = useRef(null);
  const wrapRef = useRef(null);

  const fetchGold = useCallback(async () => {
    // Skip network work while nobody is looking; the poll that runs after
    // the tab becomes visible again refreshes immediately.
    if (document.visibilityState === "hidden") return;
    try {
      abortRef.current = new AbortController();
      const res = await fetch(GOLD_API_URL, { signal: abortRef.current.signal });
      if (!res.ok) throw new Error(`gold-api ${res.status}`);
      const data = await res.json();
      const price = Number(data?.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error("bad price");

      const prev = prevPriceRef.current;
      if (prev != null && price !== prev) {
        setDirection(price > prev ? "up" : "down");
        setFlash(true);
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlash(false), 1200);
      }
      prevPriceRef.current = price;

      setUsdPerOzt(price);
      setUpdatedAt(Date.now());
      setIsStale(false);
    } catch (err) {
      if (err?.name === "AbortError") return;
      // Keep the last good price on screen, just flag it as stale.
      console.warn("[GOLD-TICKER] fetch failed:", err?.message);
      setIsStale(true);
    }
  }, []);

  const fetchFx = useCallback(async () => {
    try {
      const res = await fetch(FX_API_URL);
      if (!res.ok) throw new Error(`er-api ${res.status}`);
      const data = await res.json();
      const rate = Number(data?.rates?.PHP);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error("bad rate");
      setPhpPerUsd(rate);
    } catch (err) {
      console.warn("[GOLD-TICKER] FX fetch failed:", err?.message);
      // Leave the previous rate in place (or null → "loading" state).
    }
  }, []);

  const fetchSummary = useCallback(async () => {
    const token = getAdminToken();
    if (!token) return; // pre-login render — nothing to show yet
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/gold/summary`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!res.ok) return; // trend intel is additive — live price still works
      const data = await res.json();
      // Accept only a well-formed summary — a proxy/mock answering {} (or a
      // future shape change) must degrade to "no trend", never crash the header.
      if (!Number.isFinite(data?.current?.phpPerGram) || typeof data?.deltas !== "object") return;
      setSummary(data);
    } catch (err) {
      console.warn("[GOLD-TICKER] summary fetch failed:", err?.message);
    }
  }, []);

  useEffect(() => {
    fetchGold();
    fetchFx();
    fetchSummary();
    const goldTimer = setInterval(fetchGold, GOLD_POLL_MS);
    const fxTimer = setInterval(fetchFx, FX_REFRESH_MS);
    const summaryTimer = setInterval(fetchSummary, SUMMARY_POLL_MS);
    const relTimer = setInterval(() => setRelativeTick((t) => t + 1), RELATIVE_TICK_MS);

    // Refresh the moment the operator returns to the tab.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchGold();
        fetchSummary();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(goldTimer);
      clearInterval(fxTimer);
      clearInterval(summaryTimer);
      clearInterval(relTimer);
      clearTimeout(flashTimerRef.current);
      abortRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchGold, fetchFx, fetchSummary]);

  // Close the trend panel on outside click / Escape.
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setPanelOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  const ready = usdPerOzt != null && phpPerUsd != null;
  const phpPerGram = ready ? (usdPerOzt * phpPerUsd) / GRAMS_PER_TROY_OUNCE : null;
  const phpPerOzt = ready ? usdPerOzt * phpPerUsd : null;
  // Recomputed on every render — the 10s relative tick keeps this current.
  const marketClosed = isGoldMarketClosed();

  const d1 = summary?.deltas?.d1 ?? null;
  const alert = summary?.alert ?? null;
  const bigMove = alert?.significant === true;
  // Amber at threshold, red once the move doubles it (a violent day).
  const bigMoveHot = bigMove && Math.abs(alert.pct) >= alert.thresholdPct * 2;

  const deltaClass = (pct) =>
    pct > 0 ? "up" : pct < 0 ? "down" : "flat";

  return (
    <div className="gold-ticker-wrap" ref={wrapRef}>
      <div
        className={[
          "gold-ticker",
          flash ? "gold-ticker--flash" : "",
          bigMove ? (bigMoveHot ? "gold-ticker--alert-hot" : "gold-ticker--alert") : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={
          ready
            ? `Gold spot ≈ ${phpPerOztFmt.format(phpPerOzt)} per troy oz${
                marketClosed
                  ? "\nMarket closed (weekend) — showing Friday's close; trading resumes Mon ~6:00 AM Manila"
                  : ""
              }${
                bigMove
                  ? `\nGold moved ${fmtSignedPct(alert.pct)} in 24h — prices may be adjusted today (info only)`
                  : ""
              }\nClick for the 30-day trend\nSources: gold-api.com (XAU/USD) · open.er-api.com (USD/PHP)`
            : "Fetching live gold price…"
        }
        aria-live="polite"
        role="button"
        tabIndex={0}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        onClick={() => {
          setPanelOpen((o) => !o);
          if (!panelOpen) fetchSummary();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPanelOpen((o) => !o);
            if (!panelOpen) fetchSummary();
          }
        }}
      >
        <span className="gold-ticker-dot" aria-hidden="true">◉</span>
        <span className="gold-ticker-label">GOLD</span>
        {ready ? (
          <>
            <span className="gold-ticker-price">
              {phpPerGramFmt.format(phpPerGram)}
              <span className="gold-ticker-unit">/g</span>
            </span>
            {direction && (
              <span
                className={`gold-ticker-arrow gold-ticker-arrow--${direction}`}
                aria-label={direction === "up" ? "price up" : "price down"}
              >
                {direction === "up" ? "▲" : "▼"}
              </span>
            )}
            {d1 && (
              <span
                className={`gold-ticker-delta gold-ticker-delta--${deltaClass(d1.pct)}`}
                title="Change vs ~24h ago"
              >
                {fmtSignedPct(d1.pct)}
              </span>
            )}
            {bigMove && (
              <span className="gold-ticker-alert-tag" role="status">
                {alert.pct >= 0 ? "▲" : "▼"} 24H MOVE
              </span>
            )}
            <span className="gold-ticker-updated">
              {isStale ? "⚠ stale · " : ""}
              {marketClosed ? "market closed · " : ""}
              Updated {formatUpdatedAgo(updatedAt)}
            </span>
          </>
        ) : (
          <span className="gold-ticker-updated">
            {isStale ? "unavailable" : "loading…"}
          </span>
        )}
      </div>

      {panelOpen && (
        <div className="gold-panel" role="dialog" aria-label="Gold price trend">
          {summary ? (
            <>
              <div className="gold-panel-head">
                <span className="gold-panel-price">
                  {phpPerGramFmt.format(ready ? phpPerGram : summary.current.phpPerGram)}
                  <span className="gold-panel-price-unit">/g</span>
                </span>
                {ready && (
                  <span className="gold-panel-sub">
                    {phpPerOztFmt.format(phpPerOzt)}/ozt · ₱{phpPerUsd.toFixed(2)}/USD
                  </span>
                )}
              </div>

              <div className="gold-panel-deltas">
                {[
                  ["1D", summary.deltas.d1],
                  ["7D", summary.deltas.d7],
                  ["30D", summary.deltas.d30],
                ].map(([label, d]) => (
                  <span key={label} className="gold-panel-delta">
                    <span className="gold-panel-delta-label">{label}</span>
                    <span
                      className={`gold-panel-delta-value gold-panel-delta-value--${
                        d ? deltaClass(d.pct) : "flat"
                      }`}
                    >
                      {d ? fmtSignedPct(d.pct) : "—"}
                    </span>
                  </span>
                ))}
              </div>

              {summary.sparkline?.length >= 2 && (
                <div className="gold-panel-spark">
                  <svg viewBox="0 0 132 36" preserveAspectRatio="none" aria-hidden="true">
                    <polyline
                      points={sparklinePoints(summary.sparkline)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </svg>
                  {summary.week && (
                    <span className="gold-panel-range">
                      7d {phpPerGramFmt.format(summary.week.low)} – {phpPerGramFmt.format(summary.week.high)}
                    </span>
                  )}
                </div>
              )}

              <div
                className={`gold-panel-move${
                  bigMove ? (bigMoveHot ? " gold-panel-move--hot" : " gold-panel-move--warn") : ""
                }`}
              >
                {alert ? (
                  bigMove ? (
                    <>
                      Gold moved <strong>{fmtSignedPct(alert.pct)}</strong> in the last 24h
                      (beyond the ±{alert.thresholdPct}% band). Managers are notified by
                      email each morning — prices may be adjusted today.
                      <span className="gold-panel-move-foot">
                        Information only — no action needed here.
                      </span>
                    </>
                  ) : (
                    <>
                      24h movement {fmtSignedPct(alert.pct)} — within the ±
                      {alert.thresholdPct}% band, no pricing alert.
                    </>
                  )
                ) : (
                  <>
                    No ~24h-ago reference yet (weekend gap or fresh history) — the
                    daily movement check resumes with trading data.
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="gold-panel-empty">
              Trend data unavailable — history builds up a few minutes after the
              backend starts sampling.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
