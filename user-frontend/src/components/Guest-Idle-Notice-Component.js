// Shown INSIDE the chat box frame after the idle auto-close (walk-away
// protection) has erased the session. Before this, the widget silently
// vanished after 5 idle minutes — guests had no idea why their chat
// disappeared. All PII is already wiped by the time this renders; the card is
// static copy plus a dismiss button, so it is safe to leave on screen
// indefinitely (e.g. on an unattended kiosk).
import React from "react";

export const IDLE_NOTICE_TITLE = "Chat closed due to inactivity";

export default function GuestIdleNotice({ minutes = 5, onDismiss }) {
  return (
    <div className="gc-idle-notice" role="alertdialog" aria-label={IDLE_NOTICE_TITLE}>
      <div className="gc-idle-notice-icon" aria-hidden="true">🔒</div>
      <h3 className="gc-idle-notice-title">{IDLE_NOTICE_TITLE}</h3>
      <p className="gc-idle-notice-body">
        For your security and data privacy, this chat was automatically closed
        and its data cleared from this device after {minutes} minutes of
        inactivity.
      </p>
      <p className="gc-idle-notice-body">
        You can chat with us again anytime — just tap the chat button to start
        a new conversation.
      </p>
      <button type="button" className="gc-idle-notice-btn" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
