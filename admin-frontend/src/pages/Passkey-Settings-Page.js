// admin-frontend/src/pages/Passkey-Settings-Page.js
//
// Self-service passkey management for branch admins (megaplan Phase 5).
// Reached at /admin/passkeys (flag: REACT_APP_ENABLE_PASSKEYS). Additive page;
// nothing else links here yet, so it cannot disturb existing flows.

import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthShell, {
  INPUT,
  BTN_PRIMARY,
  BTN_BUSY,
  LINK_BTN,
  MSG_ERROR,
  MSG_SUCCESS,
} from "../components/AuthShell";

const API = process.env.REACT_APP_API_URL || "";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sessionStorage.getItem("branchAdminToken") || ""}`,
    "X-Session-Id": sessionStorage.getItem("mfaSessionId") || "",
  };
}

export default function PasskeySettingsPage() {
  const navigate = useNavigate();
  const [keys, setKeys] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [deviceName, setDeviceName] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/webauthn/credentials`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (res.ok) setKeys(await res.json());
      else if (res.status === 401 || res.status === 403) setError("Session expired. Please sign in again.");
    } catch {
      setError("Could not load passkeys.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addPasskey = async () => {
    setError(""); setInfo(""); setBusy(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const optRes = await fetch(`${API}/api/webauthn/register-options`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      const optBody = await optRes.json();
      if (!optRes.ok) { setError(optBody.error || "Could not start enrollment."); return; }

      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: optBody.options });
      } catch (e) {
        if (e?.name !== "NotAllowedError") setError(e?.message || "Enrollment was interrupted.");
        return;
      }

      const verRes = await fetch(`${API}/api/webauthn/register-verify`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({
          challengeId: optBody.challengeId,
          attestation,
          deviceName: deviceName.trim() || "Passkey",
        }),
      });
      const verBody = await verRes.json();
      if (!verRes.ok) { setError(verBody.error || "Enrollment failed."); return; }
      setInfo("Passkey added. You can now use it on the sign-in page.");
      setDeviceName("");
      await load();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    if (!window.confirm("Remove this passkey? You can add it again later.")) return;
    setError(""); setInfo(""); setBusy(true);
    try {
      const res = await fetch(`${API}/api/webauthn/credentials/revoke`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ id }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || "Could not remove passkey."); return; }
      setInfo("Passkey removed.");
      await load();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Passkeys"
      width="w-[28rem]"
      subtitle={
        <>
          Sign in with this device's PIN (Windows Hello) — no emailed code needed.
          Passkeys work only on the computer where you add them; phones and QR
          codes are not supported.
        </>
      }
    >
        {error && <p className={MSG_ERROR}>{error}</p>}
        {info && <p className={MSG_SUCCESS}>{info}</p>}

        <div className="mb-6">
          {keys.length === 0 && (
            <p className="text-sm text-slate-500 text-center mb-2">No passkeys yet.</p>
          )}
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-xl border border-[#ececf3] bg-white px-3 py-2 mb-2 transition-colors hover:border-[#c9a227]/50">
              <div>
                <p className="text-sm font-medium text-[#232268]">{k.deviceName || "Passkey"}</p>
                <p className="text-xs text-slate-500">
                  added {k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "—"}
                  {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(k.id)}
                disabled={busy}
                className="text-sm font-medium text-red-500 transition-colors hover:text-red-700"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <input
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="Name this passkey (e.g. Work laptop)"
          className={`${INPUT} mb-3`}
          maxLength={64}
        />
        <button
          type="button"
          onClick={addPasskey}
          disabled={busy}
          className={busy ? BTN_BUSY : BTN_PRIMARY}
        >
          {busy ? "Working…" : "Add a passkey"}
        </button>
        <button
          type="button"
          onClick={() => navigate("/admin/chats")}
          className={`${LINK_BTN} mt-3`}
        >
          Back to dashboard
        </button>
    </AuthShell>
  );
}
