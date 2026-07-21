// Waiting-guests service-level chip for the admin header.
//
// Reads the state the dashboard already owns (chats + unreadCounts) and
// answers the one question that matters between replies: "is anyone waiting
// on us, and for how long?" Neutral when clear, amber while guests wait,
// red once the longest wait crosses the SLA threshold.
import React, { useEffect, useState } from "react";

export const SLA_RED_MS = 5 * 60 * 1000; // longest wait considered "late"
const TICK_MS = 15 * 1000;

// Pure so it can be regression-tested without rendering.
export function computeWaiting(chats, unreadCounts, now = Date.now()) {
  const waiting = (chats || []).filter(
    (c) => c?.guestId && (unreadCounts?.[c.guestId] || 0) > 0
  );
  if (waiting.length === 0) return { count: 0, longestMs: 0 };

  let oldest = Infinity;
  for (const c of waiting) {
    const t = new Date(c.timestamp).getTime();
    if (Number.isFinite(t)) oldest = Math.min(oldest, t);
  }
  return {
    count: waiting.length,
    longestMs: oldest === Infinity ? 0 : Math.max(0, now - oldest),
  };
}

export function formatWait(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function HeaderWaitingChip({ chats, unreadCounts }) {
  // Wait durations must keep aging between prop updates.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const { count, longestMs } = computeWaiting(chats, unreadCounts);

  if (count === 0) {
    return (
      <div className="waiting-chip waiting-chip--clear" title="No guests awaiting a reply">
        <span aria-hidden="true">✓</span>
        <span className="waiting-chip-text">All caught up</span>
      </div>
    );
  }

  const late = longestMs >= SLA_RED_MS;
  return (
    <div
      className={`waiting-chip ${late ? "waiting-chip--late" : "waiting-chip--waiting"}`}
      title={`${count} guest${count === 1 ? "" : "s"} awaiting a reply · longest ${formatWait(longestMs)}`}
      aria-live="polite"
    >
      <span aria-hidden="true">🔔</span>
      <span className="waiting-chip-text">
        {count} waiting · {formatWait(longestMs)}
      </span>
    </div>
  );
}
