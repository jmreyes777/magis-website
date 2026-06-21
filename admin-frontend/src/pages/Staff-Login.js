// magis-project/admin-frontend/src/pages/Staff-Login.js
//
// Staff login for the branch chat dashboard: PASSWORD (factor 1) + emailed
// 6-digit code (factor 2), with "Remember this device" to skip the code on a
// known computer, and a forced password change on first login.
//
// It is fully isolated from the Firebase branch-admin login, but on success it
// establishes the SAME session artifacts that BranchAdmin-Login.finalizeLogin
// creates (sessionStorage/localStorage keys, mfaSessionId, tabId, fallback
// values, SW token, AuthContext, socket, navigate, branchAdminAuthenticated
// event) — so the dashboard, socket, and silent token rotation all work as-is.

import React, { useEffect, useState, useContext, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { jwtDecode } from "jwt-decode";
import AuthContext from "../context/AuthContext";
import { connectSocket } from "../components/Admin-Utils-socket";
import { useWakeLock } from "../utils/useWakeLock";

const API = process.env.REACT_APP_API_URL || "";
const TRUSTED_KEY = "staffTrustedDeviceToken";
const RESEND_SECONDS = 45;

function StaffLogin() {
  const navigate = useNavigate();
  const { setIsAuthenticated, setUserRole, setAdminEmail } = useContext(AuthContext);

  const [step, setStep] = useState("credentials"); // credentials | otp | changePassword
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loginTicket, setLoginTicket] = useState(null);
  const [rememberDevice, setRememberDevice] = useState(true);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pendingSession, setPendingSession] = useState(null); // {branchEmail, branchId, branchName, tabId}

  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  const [keepAwake, setKeepAwake] = useState(false);
  useWakeLock(keepAwake);

  // Fresh-login cleanup + a per-login MFA session id (sent as X-Session-Id so the
  // server writes the mfa_sessions doc under the id the dashboard later polls).
  useEffect(() => {
    localStorage.removeItem("activeSocketTabId");
    localStorage.removeItem("fallbackBranchEmail");
    localStorage.removeItem("fallbackBranchRole");
    localStorage.removeItem("fallbackBranchId");
    localStorage.removeItem("fallbackBranchName");
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith("branchChats-")) localStorage.removeItem(k);
    });
    window.__SOCKET_CONNECTED = false;
    const sid = `sess_${Date.now()}_${(crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem("mfaSessionId", sid);
  }, []);

  // Resend cooldown ticker.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const post = useCallback(async (path, body) => {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": sessionStorage.getItem("mfaSessionId") || "",
      },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    return { ok: res.ok, status: res.status, data };
  }, []);

  // Mirror BranchAdmin-Login.finalizeLogin's session setup (no Firebase bits).
  const establishSession = useCallback((token, branchNameHint) => {
    const decoded = jwtDecode(token);
    const branchEmail = decoded.email || email.trim().toLowerCase();
    const branchId = decoded.branchId;
    const branchName = branchNameHint || decoded.branchName || "Branch Admin";

    ["sessionStorage", "localStorage"].forEach((store) => {
      const s = window[store];
      s.setItem("branchAdminToken", token);
      s.setItem("branchAdminRole", "branchadmin");
      s.setItem("branchId", branchId);
      s.setItem("branchEmail", branchEmail);
      s.setItem("branchName", branchName);
    });

    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "SET_AUTH_TOKEN", token });
    }
    if (!sessionStorage.getItem("sessionTabId")) {
      sessionStorage.setItem("sessionTabId", `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    }
    let tabId = localStorage.getItem("tabId");
    if (!tabId) {
      tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("tabId", tabId);
    }
    localStorage.setItem("fallbackBranchEmail", branchEmail);
    localStorage.setItem("fallbackBranchId", branchId);
    localStorage.setItem("fallbackBranchRole", "branchadmin");
    localStorage.setItem("fallbackBranchName", branchName);

    setIsAuthenticated(true);
    setUserRole("branchadmin");
    setAdminEmail(branchEmail);

    return { branchEmail, branchId, branchName, tabId };
  }, [email, setIsAuthenticated, setUserRole, setAdminEmail]);

  const goToDashboard = useCallback((session) => {
    setTimeout(() => {
      connectSocket(session.branchEmail);
      localStorage.setItem("activeSocketTabId", session.tabId);
    }, 100);
    navigate("/admin/chats", {
      replace: true,
      state: { fromLogin: true, branchId: session.branchId, branchEmail: session.branchEmail, branchName: session.branchName },
    });
    window.dispatchEvent(new Event("branchAdminAuthenticated"));
  }, [navigate]);

  // token in hand → establish session, then either force a password change or enter.
  const completeLogin = useCallback((token, { mustChangePassword, branchName }) => {
    const session = establishSession(token, branchName);
    if (mustChangePassword) {
      setPendingSession(session);
      setStep("changePassword");
      setInfo("For security, please set a new password to finish signing in.");
      return;
    }
    goToDashboard(session);
  }, [establishSession, goToDashboard]);

  const handleCredentials = async (e) => {
    e.preventDefault();
    setError(""); setInfo(""); setBusy(true); setKeepAwake(true);
    try {
      const { ok, status, data } = await post("/api/staff/login", {
        email: email.trim().toLowerCase(),
        password,
        trustedDeviceToken: localStorage.getItem(TRUSTED_KEY) || undefined,
      });
      if (!ok) {
        setError(data.error || (status === 429 ? "Too many attempts. Please wait." : "Login failed."));
        return;
      }
      if (data.token) {
        // Trusted device or 2FA disabled → straight in.
        completeLogin(data.token, data);
        return;
      }
      if (data.otpRequired) {
        setLoginTicket(data.loginTicket);
        setStep("otp");
        setResendIn(RESEND_SECONDS);
        setInfo(`We emailed a 6-digit code to ${data.email || email.trim().toLowerCase()}.`);
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = useCallback(async (theCode) => {
    setError(""); setBusy(true);
    try {
      const { ok, status, data } = await post("/api/staff/login/verify-otp", {
        loginTicket,
        code: theCode,
        rememberDevice,
      });
      if (!ok) {
        setError(data.error || (status === 429 ? "Too many attempts." : "Verification failed."));
        setCode("");
        return;
      }
      if (data.trustedDeviceToken) localStorage.setItem(TRUSTED_KEY, data.trustedDeviceToken);
      completeLogin(data.token, data);
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [post, loginTicket, rememberDevice, completeLogin]);

  const handleOtpChange = (val) => {
    const digits = val.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !busy) submitOtp(digits); // auto-submit
  };

  const handleResend = async () => {
    if (resendIn > 0) return;
    setError(""); setBusy(true);
    try {
      const { ok, data } = await post("/api/staff/login/resend-otp", { loginTicket });
      if (!ok) setError(data.error || "Could not resend code.");
      else { setInfo("A new code has been emailed."); setResendIn(RESEND_SECONDS); }
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 10) return setError("New password must be at least 10 characters.");
    if (newPassword !== confirmPassword) return setError("Passwords do not match.");
    setBusy(true);
    try {
      const token = sessionStorage.getItem("branchAdminToken");
      const res = await fetch(`${API}/api/staff/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not change password.");
        return;
      }
      goToDashboard(pendingSession);
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="p-8 bg-white shadow-lg rounded-lg w-96">
        <h1 className="text-2xl font-bold mb-1 text-center">Staff Login</h1>
        <p className="text-xs text-gray-500 text-center mb-6">Branch chat dashboard</p>

        {error && <p className="text-red-500 text-sm text-center mb-4">{error}</p>}
        {info && <p className="text-blue-600 text-sm text-center mb-4">{info}</p>}

        {step === "credentials" && (
          <form onSubmit={handleCredentials}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Email"
              autoComplete="username"
              className="w-full px-4 py-2 border rounded-lg mb-3"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Password"
              autoComplete="current-password"
              className="w-full px-4 py-2 border rounded-lg mb-4"
            />
            <button
              type="submit"
              disabled={busy}
              className={`w-full py-2 rounded-lg text-white font-semibold ${busy ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {step === "otp" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 text-center">
              Enter the 6-digit code
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => handleOtpChange(e.target.value)}
              placeholder="••••••"
              maxLength={6}
              className="w-full px-4 py-3 border rounded-lg text-center text-2xl tracking-[0.5em] font-mono mb-3"
            />
            <label className="flex items-center justify-center gap-2 text-sm text-gray-600 mb-4">
              <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
              Remember this device for 30 days
            </label>
            <button
              type="button"
              onClick={() => submitOtp(code)}
              disabled={busy || code.length !== 6}
              className={`w-full py-2 rounded-lg text-white font-semibold ${busy || code.length !== 6 ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
            >
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>
            <button
              type="button"
              onClick={handleResend}
              disabled={resendIn > 0 || busy}
              className="w-full mt-3 text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
            >
              {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
            </button>
          </div>
        )}

        {step === "changePassword" && (
          <form onSubmit={handleChangePassword}>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              placeholder="New password (min 10 characters)"
              autoComplete="new-password"
              className="w-full px-4 py-2 border rounded-lg mb-3"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              placeholder="Confirm new password"
              autoComplete="new-password"
              className="w-full px-4 py-2 border rounded-lg mb-4"
            />
            <button
              type="submit"
              disabled={busy}
              className={`w-full py-2 rounded-lg text-white font-semibold ${busy ? "bg-gray-400" : "bg-green-600 hover:bg-green-700"}`}
            >
              {busy ? "Saving…" : "Set password & continue"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default StaffLogin;
