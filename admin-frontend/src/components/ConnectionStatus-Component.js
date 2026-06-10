import React, { useEffect, useRef, useState } from "react";
import { FiWifiOff, FiRefreshCw, FiWifi } from "react-icons/fi";
import { subscribeConnectionStatus } from "./Admin-Utils-socket";

/**
 * ConnectionStatus
 * ----------------
 * A non-intrusive network/connection banner for the admin chat dashboard.
 *
 * It distinguishes three situations the admin actually cares about:
 *   • offline      — the browser has no network (navigator offline). Real-time
 *                    chat is paused; we surface this immediately.
 *   • reconnecting — the browser has network but the realtime socket is down
 *                    (server unreachable / transient drop). Debounced so a normal
 *                    page-load connect or a quick blip never flashes a banner.
 *   • online       — fully connected. We briefly confirm "back online" only when
 *                    we are recovering from a previously-shown disruption.
 *
 * Sync is handled automatically by the socket layer (reconnect + missed-message
 * replay + authoritative presence pull), so the copy reassures rather than asks
 * the admin to do anything.
 */

// How long the socket may be disconnected (while the browser is online) before we
// actually show the amber "reconnecting" banner. Prevents flashes on initial load
// and quick reconnects.
const RECONNECT_GRACE_MS = 1500;
// How long to keep the green "back online" confirmation visible.
const RESTORED_VISIBLE_MS = 3000;

const STATUS_CONFIG = {
  offline: {
    cls: "bg-red-600 text-white",
    role: "alert",
    icon: FiWifiOff,
    spin: false,
    text: "You're offline — messages and presence will resync automatically when you're back online.",
  },
  reconnecting: {
    cls: "bg-amber-500 text-white",
    role: "status",
    icon: FiRefreshCw,
    spin: true,
    text: "Reconnecting to chat… your messages will sync as soon as you're back.",
  },
  online: {
    cls: "bg-emerald-600 text-white",
    role: "status",
    icon: FiWifi,
    spin: false,
    text: "Back online — syncing your chats.",
  },
};

const ConnectionStatus = () => {
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [socketConnected, setSocketConnected] = useState(false);

  // What we actually render (after debounce). "online" means "nothing wrong".
  const [shownStatus, setShownStatus] = useState("online");
  const [showRestored, setShowRestored] = useState(false);

  const wasDisruptedRef = useRef(false);
  const graceTimerRef = useRef(null);
  const restoreTimerRef = useRef(null);

  // ── Subscribe to browser + socket connectivity ──────────────────────────
  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const unsubscribe = subscribeConnectionStatus((connected) => {
      setSocketConnected(!!connected);
    });

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (typeof unsubscribe === "function") unsubscribe();
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    };
  }, []);

  // Raw status from the two signals (browser-offline takes precedence).
  const rawStatus = !browserOnline
    ? "offline"
    : socketConnected
    ? "online"
    : "reconnecting";

  // ── Debounce the disrupted states into what we display ──────────────────
  useEffect(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }

    if (rawStatus === "offline" || rawStatus === "online") {
      // Definite signals — reflect immediately.
      setShownStatus(rawStatus);
    } else {
      // "reconnecting" — wait out the grace window; if it resolves first, the
      // cleanup above cancels this and we never flash a banner.
      graceTimerRef.current = setTimeout(() => {
        setShownStatus("reconnecting");
      }, RECONNECT_GRACE_MS);
    }

    return () => {
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    };
  }, [rawStatus]);

  // ── Brief "back online" confirmation after a shown disruption ───────────
  useEffect(() => {
    if (shownStatus === "online") {
      if (wasDisruptedRef.current) {
        wasDisruptedRef.current = false;
        setShowRestored(true);
        if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = setTimeout(
          () => setShowRestored(false),
          RESTORED_VISIBLE_MS
        );
      }
    } else {
      wasDisruptedRef.current = true;
      setShowRestored(false);
    }
  }, [shownStatus]);

  // Nothing to show when everything is fine and no confirmation is pending.
  if (shownStatus === "online" && !showRestored) return null;

  const view = shownStatus === "online" ? STATUS_CONFIG.online : STATUS_CONFIG[shownStatus];
  const Icon = view.icon;

  return (
    <div
      role={view.role}
      aria-live="polite"
      className={`w-full px-4 py-2 text-sm flex items-center justify-center gap-2 shadow-sm ${view.cls}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${view.spin ? "animate-spin" : ""}`} aria-hidden="true" />
      <span className="font-medium text-center">{view.text}</span>
    </div>
  );
};

export default ConnectionStatus;
