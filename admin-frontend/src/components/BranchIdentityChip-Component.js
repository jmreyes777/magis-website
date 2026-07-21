// Branch identity + live connection dot for the admin header.
//
// Staff share machines; this makes "which branch account is this, and is the
// socket actually alive?" visible at a glance instead of discoverable only
// when the disconnect banner fires. Health is polled (the socket util keeps
// its state internal):
//   green  — socket connected, heartbeat running
//   amber  — socket connected, heartbeat not running (degraded)
//   red    — socket disconnected
import React, { useEffect, useState } from "react";
import {
  getSocketInstance,
  isHeartbeatActive,
} from "./Admin-Utils-socket";

const POLL_MS = 5 * 1000;

export function healthOf(connected, heartbeat) {
  if (!connected) return "down";
  return heartbeat ? "ok" : "degraded";
}

const HEALTH_TEXT = {
  ok: "Connected — live",
  degraded: "Connected — heartbeat inactive",
  down: "Disconnected — messages will not arrive",
};

export default function BranchIdentityChip({ branchEmail }) {
  const [health, setHealth] = useState("down");

  useEffect(() => {
    const check = () => {
      const connected = !!getSocketInstance()?.connected;
      setHealth(healthOf(connected, isHeartbeatActive()));
    };
    check();
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, []);

  if (!branchEmail) return null;

  const account = String(branchEmail).split("@")[0];

  return (
    <div
      className={`identity-chip identity-chip--${health}`}
      title={`${branchEmail}\n${HEALTH_TEXT[health]}`}
    >
      <span className="identity-chip-dot" aria-hidden="true" />
      <span className="identity-chip-name">{account}</span>
    </div>
  );
}
