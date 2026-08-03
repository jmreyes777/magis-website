// user-frontend/src/components/Guest-Csat-Toast.js
//
// CHATUX2: the post-chat rating toast. Mounted ONCE in App.js; renders
// nothing until a `magis:csat` event arrives (dispatched by utils/csat.js
// after an eligible chat closes — staff replied + 14-day cooldown elapsed).
//
// Non-negotiables (per product decision):
//   - Never blocks anything: the chat is already closed when this appears.
//   - Self-dismissing: fades out on its own after AUTO_DISMISS_MS.
//   - One tap to rate, one tap to dismiss; Escape dismisses too.
//   - Submission is fire-and-forget; failures just thank-and-fade (the guest
//     should never see an error for optional feedback).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CSAT_EVENT } from "../utils/csat";
import "./Guest-Csat-Toast.css";

const AUTO_DISMISS_MS = 12_000;
const THANKS_MS = 1_600;
const EXIT_ANIM_MS = 240; // keep in sync with .csat-toast--leaving

const STAR_LABELS = [
  "Poor (1 of 5)",
  "Fair (2 of 5)",
  "Good (3 of 5)",
  "Very good (4 of 5)",
  "Excellent (5 of 5)",
];

export default function GuestCsatToast() {
  const [prompt, setPrompt] = useState(null); // { guestId, branchEmail, branchName }
  const [hovered, setHovered] = useState(0);
  const [phase, setPhase] = useState("idle"); // idle | asking | thanks | leaving
  const timersRef = useRef([]);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };
  const later = (fn, ms) => timersRef.current.push(setTimeout(fn, ms));

  const leave = useCallback(() => {
    setPhase("leaving");
    later(() => {
      setPrompt(null);
      setPhase("idle");
      setHovered(0);
    }, EXIT_ANIM_MS);
  }, []);

  // Listen for prompts from the chat close flow.
  useEffect(() => {
    const onPrompt = (e) => {
      clearTimers();
      setPrompt(e.detail || {});
      setPhase("asking");
      setHovered(0);
      later(leave, AUTO_DISMISS_MS); // ignoring it costs nothing
    };
    window.addEventListener(CSAT_EVENT, onPrompt);
    return () => {
      window.removeEventListener(CSAT_EVENT, onPrompt);
      clearTimers();
    };
  }, [leave]);

  // Escape dismisses (only while asking).
  useEffect(() => {
    if (phase !== "asking") return;
    const onKey = (e) => {
      if (e.key === "Escape") leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, leave]);

  const submit = (rating) => {
    if (!prompt || phase !== "asking") return;
    clearTimers();

    // Fire-and-forget: thank immediately, deliver in the background.
    try {
      const token =
        sessionStorage.getItem("guestToken") ||
        localStorage.getItem("guestToken") ||
        window.__FALLBACK_GUEST_TOKEN__;
      fetch(`${process.env.REACT_APP_API_URL || ""}/api/guest/csat`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          guestId: prompt.guestId,
          branchEmail: prompt.branchEmail,
          rating,
        }),
      }).catch(() => {});
    } catch {
      /* optional feedback — never surface errors */
    }

    setPhase("thanks");
    later(leave, THANKS_MS);
  };

  if (!prompt || phase === "idle") return null;

  return (
    <div
      className={`csat-toast ${phase === "leaving" ? "csat-toast--leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      {phase === "thanks" ? (
        <p className="csat-toast-thanks">Salamat po sa feedback! 💛</p>
      ) : (
        <>
          <div className="csat-toast-head">
            <p className="csat-toast-question">
              Kumusta ang serbisyo{prompt.branchName ? ` ng ${prompt.branchName}` : ""}?
            </p>
            <button
              type="button"
              className="csat-toast-close"
              aria-label="Dismiss rating prompt"
              onClick={leave}
            >
              ×
            </button>
          </div>
          <div className="csat-toast-stars" onMouseLeave={() => setHovered(0)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`csat-toast-star ${hovered >= n ? "csat-toast-star--hot" : ""}`}
                aria-label={STAR_LABELS[n - 1]}
                title={STAR_LABELS[n - 1]}
                onMouseEnter={() => setHovered(n)}
                onFocus={() => setHovered(n)}
                onClick={() => submit(n)}
              >
                ★
              </button>
            ))}
          </div>
          <p className="csat-toast-hint">Optional po ito — mawawala rin mag-isa.</p>
        </>
      )}
    </div>
  );
}
