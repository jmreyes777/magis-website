// Live gold price watch for the admin header (pawnshop daily working number).
//
// Sources — both free, no API key, CORS-open:
//   • XAU spot (USD/troy oz): https://api.gold-api.com/price/XAU  (polled 60s)
//   • USD→PHP rate:           https://open.er-api.com/v6/latest/USD (refreshed
//     every 6h — the source itself updates ~daily)
//
// Display: PHP per GRAM (what branches actually quote) with ▲/▼ vs the
// previous poll, plus a live "Updated Xs ago" indicator. Keeps the last good
// price on transient failures (marked stale), pauses polling while the tab is
// hidden, and cleans up all timers/requests on unmount.
import React, { useCallback, useEffect, useRef, useState } from "react";

const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
const GOLD_POLL_MS = 60 * 1000;
const FX_REFRESH_MS = 6 * 60 * 60 * 1000;
const RELATIVE_TICK_MS = 10 * 1000;
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

export default function GoldPriceTicker() {
  const [usdPerOzt, setUsdPerOzt] = useState(null);
  const [phpPerUsd, setPhpPerUsd] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [direction, setDirection] = useState(null); // "up" | "down" | null
  const [isStale, setIsStale] = useState(false);
  const [flash, setFlash] = useState(false);
  // Re-render ticker so "Xs ago" stays honest between polls.
  const [, setRelativeTick] = useState(0);

  const prevPriceRef = useRef(null);
  const flashTimerRef = useRef(null);
  const abortRef = useRef(null);

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

  useEffect(() => {
    fetchGold();
    fetchFx();
    const goldTimer = setInterval(fetchGold, GOLD_POLL_MS);
    const fxTimer = setInterval(fetchFx, FX_REFRESH_MS);
    const relTimer = setInterval(() => setRelativeTick((t) => t + 1), RELATIVE_TICK_MS);

    // Refresh the moment the operator returns to the tab.
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchGold();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(goldTimer);
      clearInterval(fxTimer);
      clearInterval(relTimer);
      clearTimeout(flashTimerRef.current);
      abortRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchGold, fetchFx]);

  const ready = usdPerOzt != null && phpPerUsd != null;
  const phpPerGram = ready ? (usdPerOzt * phpPerUsd) / GRAMS_PER_TROY_OUNCE : null;
  const phpPerOzt = ready ? usdPerOzt * phpPerUsd : null;
  // Recomputed on every render — the 10s relative tick keeps this current.
  const marketClosed = isGoldMarketClosed();

  return (
    <div
      className={`gold-ticker${flash ? " gold-ticker--flash" : ""}`}
      title={
        ready
          ? `Gold spot ≈ ${phpPerOztFmt.format(phpPerOzt)} per troy oz${
              marketClosed
                ? "\nMarket closed (weekend) — showing Friday's close; trading resumes Mon ~6:00 AM Manila"
                : ""
            }\nSources: gold-api.com (XAU/USD) · open.er-api.com (USD/PHP)`
          : "Fetching live gold price…"
      }
      aria-live="polite"
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
  );
}
