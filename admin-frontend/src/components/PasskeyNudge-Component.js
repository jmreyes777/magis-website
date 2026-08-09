// SEC26 Wave 5: passkey adoption nudge — encouragement, NOT enforcement.
//
// Shows one dismissible banner on the chat dashboard when the signed-in
// branch admin has zero enrolled passkeys. "Later" snoozes it for 14 days
// (localStorage, per-browser). Renders nothing — and can never break the
// dashboard — when: the feature flag is off, the browser lacks WebAuthn,
// the credentials call fails, or a passkey already exists.
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const SNOOZE_KEY = "passkeyNudgeSnoozedUntil";
const SNOOZE_DAYS = 14;

const PasskeyNudge = () => {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const shouldEvenCheck = () => {
      if (process.env.REACT_APP_ENABLE_PASSKEYS !== "true") return false;
      if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
      const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      if (until > Date.now()) return false;
      return true;
    };

    const check = async () => {
      if (!shouldEvenCheck()) return;
      try {
        const token =
          sessionStorage.getItem("branchAdminToken") ||
          localStorage.getItem("branchAdminToken");
        if (!token) return;
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/webauthn/credentials`,
          {
            headers: { Authorization: `Bearer ${token}` },
            credentials: "include",
          }
        );
        if (!res.ok) return; // nudge is best-effort; never surface errors
        const creds = await res.json();
        if (!cancelled && Array.isArray(creds) && creds.length === 0) {
          setVisible(true);
        }
      } catch {
        /* silent — a nudge must never degrade the dashboard */
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const snooze = () => {
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000)
    );
    setVisible(false);
  };

  return (
    <div
      className="w-full bg-indigo-50 border-b border-indigo-200 text-indigo-900 px-4 py-2 flex items-center justify-between gap-3 text-sm"
      role="status"
    >
      <span>
        <strong>Protect this account with a passkey.</strong>{" "}
        Sign in with your fingerprint or face — phishing-resistant, and faster
        than password + OTP.
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => navigate("/admin/passkeys")}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded"
        >
          Set up
        </button>
        <button
          type="button"
          onClick={snooze}
          className="text-indigo-700 hover:text-indigo-900 px-2 py-1"
          aria-label="Remind me later"
        >
          Later
        </button>
      </span>
    </div>
  );
};

export default PasskeyNudge;
