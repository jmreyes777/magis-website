// admin-frontend/src/pages/Passkey-Settings-Page.js
//
// Self-service passkey management for branch admins (megaplan Phase 5).
// Reached at /admin/passkeys (flag: REACT_APP_ENABLE_PASSKEYS). Additive page;
// nothing else links here yet, so it cannot disturb existing flows.

import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="p-8 bg-white shadow-lg rounded-lg w-[28rem]">
        <h1 className="text-2xl font-bold mb-1 text-center">Passkeys</h1>
        <p className="text-xs text-gray-500 text-center mb-6">
          Sign in with this device's PIN (Windows Hello) — no emailed code needed.
          Passkeys work only on the computer where you add them; phones and QR
          codes are not supported.
        </p>

        {error && <p className="text-red-500 text-sm text-center mb-4">{error}</p>}
        {info && <p className="text-green-600 text-sm text-center mb-4">{info}</p>}

        <div className="mb-6">
          {keys.length === 0 && (
            <p className="text-sm text-gray-500 text-center mb-2">No passkeys yet.</p>
          )}
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between border rounded-lg px-3 py-2 mb-2">
              <div>
                <p className="text-sm font-medium">{k.deviceName || "Passkey"}</p>
                <p className="text-xs text-gray-500">
                  added {k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "—"}
                  {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(k.id)}
                disabled={busy}
                className="text-sm text-red-600 hover:text-red-800"
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
          className="w-full px-4 py-2 border rounded-lg mb-3"
          maxLength={64}
        />
        <button
          type="button"
          onClick={addPasskey}
          disabled={busy}
          className={`w-full py-2 rounded-lg text-white font-semibold ${busy ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
        >
          {busy ? "Working…" : "Add a passkey"}
        </button>
        <button
          type="button"
          onClick={() => navigate("/admin/chats")}
          className="w-full mt-3 text-sm text-blue-600 hover:text-blue-800"
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}
