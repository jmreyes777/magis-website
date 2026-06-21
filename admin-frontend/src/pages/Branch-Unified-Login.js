// magis-project/admin-frontend/src/pages/Branch-Unified-Login.js
//
// UNIFIED branch login — ONE entry for both kinds of per-branch operator, so the
// person never has to know which kind of account they have ("maximum
// convenience": one button, one form):
//
//   • Staff accounts        : password (factor 1) + EMAILED 6-digit code
//                             (factor 2), "remember this device", and a forced
//                             first-login password change. Authenticated entirely
//                             by the backend (/api/staff/login*).
//   • Firebase branch-admins: password + TOTP (Google Authenticator), incl.
//                             first-time TOTP enrollment. Authenticated by
//                             Firebase. Preserved verbatim from the former
//                             BranchAdmin-Login page (incl. fallback-token +
//                             session-verify handshake).
//
// Both resolve to the SAME role ("branchadmin"), the SAME session artifacts, and
// the SAME destination (/admin/chats).
//
// Routing logic (single email+password form):
//   1. POST /api/staff/login.
//        • 200 + token       -> staff is in (2FA off or trusted device).
//        • 200 + otpRequired -> staff emailed-OTP step.
//        • 401               -> NOT a staff account OR wrong staff password. The
//                               backend keeps this generic (anti-enumeration), so
//                               we fall through to the Firebase flow, which
//                               authoritatively reports success/error.
//        • 403/429/4xx/5xx   -> show the backend message (disabled, locked, ...).

import React, { useEffect, useState, useContext, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { jwtDecode } from "jwt-decode";
import AuthContext from "../context/AuthContext";
import { connectSocket } from "../components/Admin-Utils-socket";
import { useWakeLock } from "../utils/useWakeLock";
import {
  getAuth,
  signInWithEmailAndPassword,
  getMultiFactorResolver,
  multiFactor,
  TotpMultiFactorGenerator,
  sendEmailVerification,
} from "firebase/auth";
import { fetchCustomClaims } from "../firebase-config";
import { QRCodeCanvas } from "qrcode.react";

const API = process.env.REACT_APP_API_URL || "";
const TRUSTED_KEY = "staffTrustedDeviceToken";
const RESEND_SECONDS = 45;
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function BranchUnifiedLogin() {
  const navigate = useNavigate();
  const { setIsAuthenticated, setUserRole, setAdminEmail } = useContext(AuthContext);

  // Shared
  const [view, setView] = useState("credentials"); // credentials | staffOtp | staffChangePassword | fbTotp | fbEnroll
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  // Staff flow
  const [code, setCode] = useState("");
  const [loginTicket, setLoginTicket] = useState(null);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pendingSession, setPendingSession] = useState(null);
  const [resendIn, setResendIn] = useState(0);
  const [resetCode, setResetCode] = useState("");

  // Firebase flow
  const [totpCode, setTotpCode] = useState("");
  const [mfaResolver, setMfaResolver] = useState(null);
  const [selectedMfaHint, setSelectedMfaHint] = useState(null);
  const [totpSecret, setTotpSecret] = useState(null);
  const [emailSent, setEmailSent] = useState(false);
  const [enrollmentSuccess, setEnrollmentSuccess] = useState(false);

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

  // Resend cooldown ticker (staff OTP).
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

  // ── Shared session/dashboard helpers ───────────────────────────────────────
  const ensureIds = () => {
    if (!sessionStorage.getItem("sessionTabId")) {
      sessionStorage.setItem("sessionTabId", `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    }
    let tabId = localStorage.getItem("tabId");
    if (!tabId) {
      tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("tabId", tabId);
    }
    return tabId;
  };

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

  // ── STAFF flow ──────────────────────────────────────────────────────────────
  const establishStaffSession = useCallback((token, branchNameHint) => {
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
    const tabId = ensureIds();
    localStorage.setItem("fallbackBranchEmail", branchEmail);
    localStorage.setItem("fallbackBranchId", branchId);
    localStorage.setItem("fallbackBranchRole", "branchadmin");
    localStorage.setItem("fallbackBranchName", branchName);

    setIsAuthenticated(true);
    setUserRole("branchadmin");
    setAdminEmail(branchEmail);
    return { branchEmail, branchId, branchName, tabId };
  }, [email, setIsAuthenticated, setUserRole, setAdminEmail]);

  const completeStaffLogin = useCallback((token, { mustChangePassword, branchName }) => {
    const session = establishStaffSession(token, branchName);
    if (mustChangePassword) {
      setPendingSession(session);
      setView("staffChangePassword");
      setInfo("First time here? You can set your own password now, or skip to keep the one you were given.");
      return;
    }
    goToDashboard(session);
  }, [establishStaffSession, goToDashboard]);

  const submitOtp = useCallback(async (theCode) => {
    setError(""); setBusy(true);
    try {
      const { ok, status, data } = await post("/api/branch/login/verify-otp", {
        loginTicket, code: theCode, rememberDevice,
      });
      if (!ok) {
        setError(data.error || (status === 429 ? "Too many attempts." : "Verification failed."));
        setCode("");
        return;
      }
      if (data.trustedDeviceToken) localStorage.setItem(TRUSTED_KEY, data.trustedDeviceToken);
      completeStaffLogin(data.token, data);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [post, loginTicket, rememberDevice, completeStaffLogin]);

  const handleOtpChange = (val) => {
    const digits = val.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !busy) submitOtp(digits); // auto-submit
  };

  const handleResend = async () => {
    if (resendIn > 0) return;
    setError(""); setBusy(true);
    try {
      const { ok, data } = await post("/api/branch/login/resend-otp", { loginTicket });
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
      const res = await fetch(`${API}/api/branch/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || "Could not change password."); return; }
      goToDashboard(pendingSession);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleForgotRequest = async (e) => {
    e.preventDefault();
    setError(""); setInfo(""); setBusy(true);
    const cleanEmail = email.trim().toLowerCase();
    try {
      await post("/api/branch/forgot", { email: cleanEmail });
      setView("reset");
      setResendIn(RESEND_SECONDS);
      setInfo(`If ${cleanEmail} is a branch account, a reset code has been emailed.`);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 10) return setError("New password must be at least 10 characters.");
    if (newPassword !== confirmPassword) return setError("Passwords do not match.");
    setBusy(true);
    try {
      const { ok, status, data } = await post("/api/branch/reset", {
        email: email.trim().toLowerCase(), code: resetCode, newPassword,
      });
      if (!ok) {
        setError(data.error || (status === 429 ? "Too many attempts." : "Could not reset password."));
        return;
      }
      setInfo("Password updated. Please sign in with your new password.");
      setPassword(""); setNewPassword(""); setConfirmPassword(""); setResetCode("");
      setView("credentials");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // ── FIREBASE branch-admin flow (fall-through on staff 401) ──────────────────
  const finalizeFirebaseLogin = useCallback(async (user, customClaims) => {
    const firebaseToken = await user.getIdToken();
    const branchEmail = user.email;
    const branchName = customClaims.branchName || "Branch Admin";

    ["sessionStorage", "localStorage"].forEach((store) => {
      const s = window[store];
      s.setItem("branchAdminToken", firebaseToken);
      s.setItem("branchAdminRole", "branchadmin");
      s.setItem("branchId", customClaims.branchId);
      s.setItem("branchEmail", branchEmail);
      s.setItem("branchName", branchName);
    });

    const mfaSessionId = `sess_${Date.now()}_${crypto.randomUUID()}`;
    sessionStorage.setItem("mfaSessionId", mfaSessionId);

    // Exchange the Firebase ID token for the short-lived HMAC fallback token
    // FIRST — the edge worker only verifies HMAC fallback tokens, not RS256
    // Firebase ID tokens, so this must exist before any protected API call.
    try {
      const res = await fetch(`${API}/api/issue-fallback-token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${firebaseToken}` },
        body: JSON.stringify({ branchEmail }),
      });
      const body = await res.json();
      if (res.ok && body.token) {
        sessionStorage.setItem("branchAdminToken", body.token);
        localStorage.setItem("branchAdminToken", body.token);
      } else {
        console.warn("[LOGIN] Could not fetch fallback token:", body.error);
      }
    } catch (err) {
      console.error("[LOGIN] Error issuing fallback token:", err);
    }

    // Record the MFA session (needs the RS256 Firebase token w/ fresh TOTP).
    try {
      await fetch(`${API}/api/mfa/session-verify`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${firebaseToken}`,
          "X-Session-Id": mfaSessionId,
        },
      });
    } catch (err) {
      console.warn("[MFA] Could not record session verification:", err);
    }

    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "SET_AUTH_TOKEN",
        token: sessionStorage.getItem("branchAdminToken"),
      });
    }

    const tabId = ensureIds();
    localStorage.setItem("fallbackBranchEmail", customClaims.branchEmail || branchEmail);
    localStorage.setItem("fallbackBranchId", customClaims.branchId);
    localStorage.setItem("fallbackBranchRole", "branchadmin");
    localStorage.setItem("fallbackBranchName", branchName);
    localStorage.setItem("testBranchAdminEmail", branchEmail);
    localStorage.setItem("testBranchAdminPassword", password);

    setIsAuthenticated(true);
    setUserRole("branchadmin");
    setAdminEmail(branchEmail);

    goToDashboard({ branchEmail, branchId: customClaims.branchId, branchName, tabId });
  }, [password, goToDashboard, setIsAuthenticated, setUserRole, setAdminEmail]);

  const runFirebaseLogin = useCallback(async (cleanEmail, cleanPassword) => {
    const auth = getAuth();
    try {
      if (!isValidEmail(cleanEmail)) throw new Error("Please enter a valid email address.");

      const recaptchaSiteKey = process.env.REACT_APP_RECAPTCHA_SITE_KEY;
      if (!recaptchaSiteKey) {
        setError("Authentication service unavailable. Please try again later.");
        return;
      }
      if (!window.grecaptcha || !window.grecaptcha.execute) {
        setTimeout(() => runFirebaseLogin(cleanEmail, cleanPassword), 1000);
        return;
      }
      try {
        const recaptchaToken = await window.grecaptcha.execute(recaptchaSiteKey, { action: "login" });
        sessionStorage.setItem("recaptchaToken", recaptchaToken);
      } catch {
        setError("reCAPTCHA verification failed. Please refresh and try again.");
        return;
      }

      const userCredential = await signInWithEmailAndPassword(auth, cleanEmail, cleanPassword);
      const user = userCredential.user;

      if (!user.emailVerified) {
        if (!emailSent) {
          await sendEmailVerification(user);
          setEmailSent(true);
          throw new Error("A verification email has been sent. Please verify before logging in again.");
        }
        throw new Error("Please verify your email before logging in.");
      }

      const customClaims = await fetchCustomClaims(user);
      if (!customClaims || customClaims.role !== "branchadmin") {
        throw new Error("Access denied. You are not authorized for branch access.");
      }

      const enrolledFactors = user.multiFactor?.enrolledFactors || [];
      if (enrolledFactors.length === 0) {
        // First-time TOTP enrollment.
        const multiFactorSession = await multiFactor(user).getSession();
        const secret = await TotpMultiFactorGenerator.generateSecret(multiFactorSession);
        setTotpSecret(secret);
        setView("fbEnroll");
        return;
      }

      const resolver = getMultiFactorResolver(auth, userCredential);
      setMfaResolver(resolver);
      const totpHint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
      if (!totpHint) throw new Error("TOTP factor not found. Please use a valid second factor.");
      setSelectedMfaHint(totpHint);
      setView("fbTotp");
    } catch (err) {
      if (err.code === "auth/multi-factor-auth-required") {
        try {
          const resolver = getMultiFactorResolver(auth, err);
          setMfaResolver(resolver);
          const totpHint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
          if (!totpHint) throw new Error("TOTP factor not found. Please use a valid second factor.");
          setSelectedMfaHint(totpHint);
          setView("fbTotp");
          return;
        } catch {
          setError("Failed to set up MFA resolver. Try again.");
          return;
        }
      }
      // Keep credential failures generic (anti-enumeration), like the backend.
      if (
        err.code === "auth/wrong-password" ||
        err.code === "auth/user-not-found" ||
        err.code === "auth/invalid-credential"
      ) {
        setError("Invalid email or password.");
      } else {
        setError(err.message || "Login failed.");
      }
      try {
        const t = await window.grecaptcha.execute(process.env.REACT_APP_RECAPTCHA_SITE_KEY, { action: "login" });
        sessionStorage.setItem("recaptchaToken", t);
      } catch { /* ignore */ }
    }
  }, [emailSent, finalizeFirebaseLogin]);

  const handleTotpVerification = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError("");
    if (!mfaResolver || !selectedMfaHint) {
      setError("MFA session expired. Please try logging in again.");
      return;
    }
    setBusy(true);
    try {
      const mfaEnrollmentId = selectedMfaHint?.uid || selectedMfaHint?.mfaEnrollmentId;
      if (!mfaEnrollmentId) throw new Error("MFA Enrollment ID is missing. Unable to verify OTP.");
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(mfaEnrollmentId, totpCode.trim());
      const userCredential = await mfaResolver.resolveSignIn(assertion);
      const customClaims = await fetchCustomClaims(userCredential.user);
      await finalizeFirebaseLogin(userCredential.user, customClaims);
    } catch {
      setError("Invalid or expired code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleEnrollTotp = async () => {
    if (!totpSecret || !totpCode) { setError("Please enter the code from your Authenticator app."); return; }
    setBusy(true);
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, totpCode.trim());
      await multiFactor(getAuth().currentUser).enroll(assertion, "Google Authenticator");
      setEnrollmentSuccess(true);
      setError("");
      setTotpSecret(null);
      setTotpCode("");
      setTimeout(() => window.location.reload(), 2000); // re-run login now that MFA exists
    } catch {
      setError("Invalid or expired code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // ── Orchestrator: staff first, fall through to Firebase on 401 ──────────────
  const handleCredentials = async (e) => {
    e.preventDefault();
    setError(""); setInfo(""); setBusy(true); setKeepAwake(true);
    const cleanEmail = email.trim().toLowerCase();
    try {
      const { ok, status, data } = await post("/api/branch/login", {
        email: cleanEmail,
        password,
        trustedDeviceToken: localStorage.getItem(TRUSTED_KEY) || undefined,
      });
      if (ok && data.token) { completeStaffLogin(data.token, data); return; }
      if (ok && data.otpRequired) {
        setLoginTicket(data.loginTicket);
        setView("staffOtp");
        setResendIn(RESEND_SECONDS);
        setInfo(`We emailed a 6-digit code to ${data.email || cleanEmail}.`);
        return;
      }
      if (status === 401) {
        // Not a staff account (or wrong staff password). The Firebase flow gives
        // the authoritative success/error for branch-admin accounts.
        await runFirebaseLogin(cleanEmail, password.trim());
        return;
      }
      // 403 disabled, 429 locked, 400 validation, 5xx — surface the message.
      setError(data.error || (status === 429 ? "Too many attempts. Please wait." : "Login failed."));
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // ── UI ──────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="p-8 bg-white shadow-lg rounded-lg w-96">
        <h1 className="text-2xl font-bold mb-1 text-center">Branch Login</h1>
        <p className="text-xs text-gray-500 text-center mb-6">Staff &amp; Branch Admin &middot; Chat dashboard</p>

        {error && <p className="text-red-500 text-sm text-center mb-4">{error}</p>}
        {info && <p className="text-blue-600 text-sm text-center mb-4">{info}</p>}
        {emailSent && <p className="text-blue-500 text-sm text-center mb-4">A verification email has been sent. Please check your email.</p>}

        {view === "credentials" && (
          <form onSubmit={handleCredentials} noValidate>
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
            <button
              type="button"
              onClick={() => { setError(""); setInfo(""); setView("forgot"); }}
              className="w-full mt-3 text-sm text-blue-600 hover:text-blue-800"
            >
              Forgot password?
            </button>
          </form>
        )}

        {view === "staffOtp" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 text-center">Enter the 6-digit code</label>
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

        {view === "staffChangePassword" && (
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
            <button
              type="button"
              onClick={() => goToDashboard(pendingSession)}
              disabled={busy}
              className="w-full mt-3 text-sm text-gray-600 hover:text-gray-800"
            >
              Skip for now
            </button>
          </form>
        )}

        {view === "forgot" && (
          <form onSubmit={handleForgotRequest}>
            <p className="text-sm text-gray-600 mb-3 text-center">Enter your branch email and we'll email you a reset code.</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Email"
              autoComplete="username"
              className="w-full px-4 py-2 border rounded-lg mb-4"
            />
            <button
              type="submit"
              disabled={busy}
              className={`w-full py-2 rounded-lg text-white font-semibold ${busy ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
            >
              {busy ? "Sending..." : "Send reset code"}
            </button>
            <button
              type="button"
              onClick={() => { setError(""); setInfo(""); setView("credentials"); }}
              className="w-full mt-3 text-sm text-blue-600 hover:text-blue-800"
            >
              Back to sign in
            </button>
          </form>
        )}

        {view === "reset" && (
          <form onSubmit={handleReset}>
            <input
              type="text"
              inputMode="numeric"
              value={resetCode}
              onChange={(e) => setResetCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              placeholder="6-digit reset code"
              maxLength={6}
              className="w-full px-4 py-2 border rounded-lg mb-3 text-center tracking-[0.4em] font-mono"
            />
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
              {busy ? "Updating..." : "Reset password"}
            </button>
            <button
              type="button"
              onClick={() => { setError(""); setInfo(""); setView("credentials"); }}
              className="w-full mt-3 text-sm text-blue-600 hover:text-blue-800"
            >
              Back to sign in
            </button>
          </form>
        )}

        {view === "fbTotp" && (
          <div className="text-center">
            <label htmlFor="mfaOtp" className="block text-sm font-medium text-gray-700 mb-1">Authenticator code</label>
            <input
              id="mfaOtp"
              type="text"
              inputMode="numeric"
              autoFocus
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              maxLength={6}
              placeholder="Enter 6-digit code"
              className="w-full px-4 py-2 border rounded-lg mb-4"
            />
            <button
              type="button"
              onClick={handleTotpVerification}
              disabled={busy}
              className={`w-full py-2 rounded-lg text-white font-semibold ${busy ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}
            >
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>
          </div>
        )}

        {view === "fbEnroll" && totpSecret && (
          <div className="text-center">
            <QRCodeCanvas value={totpSecret.generateQrCodeUrl(email, "Magis Admin")} size={180} />
            <p className="text-sm mt-2">Scan the QR code with Google Authenticator, then enter the code below.</p>
            <label htmlFor="enrollOtp" className="block text-sm font-medium text-gray-700 mt-4">One-Time Passcode</label>
            <input
              id="enrollOtp"
              type="text"
              inputMode="numeric"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              maxLength={6}
              placeholder="Enter 6-digit code"
              className="w-full px-4 py-2 border rounded-lg mt-1 mb-2"
            />
            {enrollmentSuccess && <p className="text-green-500 text-sm mt-2">Enrollment successful! Redirecting…</p>}
            <button
              type="button"
              onClick={handleEnrollTotp}
              disabled={busy}
              className={`w-full py-2 mt-2 rounded-lg text-white font-semibold ${busy ? "bg-gray-400" : "bg-green-600 hover:bg-green-700"}`}
            >
              {busy ? "Enrolling…" : "Enroll & continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default BranchUnifiedLogin;
