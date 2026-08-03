// CHATUX3: header bell that arms/disarms staff web-push for this device.
//
// One button, four states (see pushManager.getPushState):
//   unsupported → hidden entirely (no dead UI)
//   denied      → shown disabled with a tooltip explaining the browser block
//   unsubscribed→ outline bell; click = permission prompt + subscribe
//   subscribed  → filled bell; click = unsubscribe (this device only)

import React, { useEffect, useState, useCallback } from "react";
import {
  isPushSupported,
  getPushState,
  enablePush,
  disablePush,
} from "../utils/pushManager";
import "./PushBell-Component.css";

export default function PushBell() {
  const [state, setState] = useState("loading"); // loading | unsupported | denied | subscribed | unsubscribed
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!isPushSupported()) {
      setState("unsupported");
      return undefined;
    }
    getPushState().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = state === "subscribed" ? await disablePush() : await enablePush();
      setState(next);
    } catch (err) {
      console.warn("[PUSH] toggle failed:", err.message);
      // Re-resolve real state rather than guessing.
      setState(await getPushState());
    } finally {
      setBusy(false);
    }
  }, [busy, state]);

  if (state === "loading" || state === "unsupported") return null;

  const on = state === "subscribed";
  const denied = state === "denied";
  const label = denied
    ? "Notifications are blocked in this browser's site settings"
    : on
    ? "Chat notifications ON for this device — click to turn off"
    : "Get notified of new guest chats even when this tab is closed";

  return (
    <button
      type="button"
      className={`push-bell ${on ? "push-bell--on" : ""} ${denied ? "push-bell--denied" : ""}`}
      onClick={toggle}
      disabled={denied || busy}
      title={label}
      aria-label={label}
      aria-pressed={on}
    >
      <svg
        className="push-bell__icon"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        {denied && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
      <span className="push-bell__text">{on ? "Alerts on" : "Alerts off"}</span>
    </button>
  );
}
