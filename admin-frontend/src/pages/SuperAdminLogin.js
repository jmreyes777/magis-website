import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  sendEmailVerification,
  getMultiFactorResolver,
  multiFactor,
  TotpMultiFactorGenerator,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { db, auth } from "../firebase-config";
import axios from "axios";
import { QRCodeCanvas } from "qrcode.react";
import AuthShell, {
  INPUT,
  INPUT_CODE,
  BTN_PRIMARY,
  BTN_BUSY,
  MSG_ERROR,
} from "../components/AuthShell";

// Configure axios to point to backend
axios.defaults.baseURL = process.env.REACT_APP_API_URL || "";
axios.defaults.withCredentials = true;

/**
 * SuperAdminLogin with TOTP MFA (bypassed for jmreyes3167@gmail.com)
 */
function SuperAdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [mfaResolver, setMfaResolver] = useState(null);
  const [selectedMfaHint, setSelectedMfaHint] = useState(null);
  const [totpSecret, setTotpSecret] = useState(null);
  const [totpCode, setTotpCode] = useState("");
  const [showEnrollment, setShowEnrollment] = useState(false);
  const [enrollSuccess, setEnrollSuccess] = useState(false);

  const navigate = useNavigate();
  const allowedDomainRe = /^[\w.-]+@magisgold\.com$/i;
  const specialAdmin = "jmreyes3167@gmail.com";

  // Finalize login: get ID token and exchange for backend JWT
  const finalizeLogin = async (user) => {
    setError("");
    try {
      const firebaseIdToken = await user.getIdToken(true);
      const resp = await axios.post(
        `/api/superadmin/login`,
        { idToken: firebaseIdToken }
      );
      sessionStorage.setItem("superAdminToken", resp.data.token);
      sessionStorage.setItem("superAdminRole", "superadmin");
      window.dispatchEvent(new Event("superAdminAuthenticated"));
      navigate("/admin/branches");
    } catch (err) {
      console.error("[ERROR] Token exchange failed:", err);
      if (err.response && err.response.status === 403) {
        setError("Access forbidden. Check your credentials and permissions.");
      } else if (err.response && err.response.status === 429) {
        const retryAfter = Number(err.response.headers?.["retry-after"]);
        setError(
          `Too many login attempts. Please wait ${
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.ceil(retryAfter / 60) + " minute(s)"
              : "about 15 minutes"
          } and try again.`
        );
      } else {
        setError("Server error. Please contact the administrator.");
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    const sanitizedEmail = email.trim();
    const rawPwd = password;

    // Domain or special-admin check
    if (!allowedDomainRe.test(sanitizedEmail) && sanitizedEmail !== specialAdmin) {
      setError("Use valid @magisgold.com or authorized email.");
      setIsLoading(false);
      return;
    }

    try {
      const userCred = await signInWithEmailAndPassword(auth, sanitizedEmail, rawPwd);
      const user = userCred.user;

      if (!user.emailVerified) {
        await sendEmailVerification(user);
        setError("Verify your email. Check inbox.");
        setIsLoading(false);
        return;
      }

      // Firestore role check for non-special admin
      if (sanitizedEmail !== specialAdmin) {
        const ref = doc(db, "superAdmins", user.uid);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().role !== "superadmin") {
          setError("Access denied.");
          setIsLoading(false);
          return;
        }
      }

      // Bypass MFA entirely for the special Super Admin
      if (sanitizedEmail === specialAdmin) {
        await finalizeLogin(user);
        return;
      }

      // Otherwise, check enrollment
      const enrolled = user.multiFactor?.enrolledFactors || [];
      if (enrolled.length === 0) {
        // Begin TOTP enrollment
        const mfaSession = await multiFactor(user).getSession();
        const secret = await TotpMultiFactorGenerator.generateSecret(mfaSession);
        setTotpSecret(secret);
        setShowEnrollment(true);
        setIsLoading(false);
        return;
      }

      // Require OTP challenge
      const resolver = getMultiFactorResolver(auth, userCred);
      const hint = resolver.hints.find(
        (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID
      );
      setSelectedMfaHint(hint || null);
      setMfaResolver(resolver);
      setIsLoading(false);
    } catch (err) {
      if (err.code === "auth/multi-factor-auth-required") {
        const resolver = getMultiFactorResolver(auth, err);
        const hint = resolver.hints.find(
          (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID
        );
        setSelectedMfaHint(hint || null);
        setMfaResolver(resolver);
      } else {
        console.error(err);
        setError(err.message || "Login failed");
      }
      setIsLoading(false);
    }
  };

  const handleEnroll = async () => {
    if (!totpSecret || !totpCode) {
      setError("Enter OTP from app.");
      return;
    }
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(
        totpSecret,
        totpCode.trim()
      );
      await multiFactor(auth.currentUser).enroll(assertion, "Google Authenticator");
      setEnrollSuccess(true);
      setError("");
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      console.error(err);
      setError("Invalid OTP. Try again.");
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!mfaResolver || !selectedMfaHint) {
      setError("MFA session expired. Please log in again.");
      setMfaResolver(null);
      return;
    }
    try {
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(
        selectedMfaHint.uid,
        totpCode.trim()
      );
      const cred = await mfaResolver.resolveSignIn(assertion);
      await finalizeLogin(cred.user);
    } catch (err) {
      console.error("[MFA] verify error:", err);
      switch (err.code) {
        case "auth/quota-exceeded":
          setError("Too many OTP attempts. Please wait and try again.");
          break;
        case "auth/multi-factor-expired-session":
          setError("MFA session expired. Please log in again.");
          setMfaResolver(null);
          break;
        default:
          setError("Invalid or expired OTP. Please try again.");
      }
    }
  };

  return (
    <AuthShell title="Super Admin Login" subtitle="Branches · Staff · Observability">
        {error && <p className={MSG_ERROR}>{error}</p>}
        <form
          onSubmit={
            mfaResolver
              ? handleVerify
              : showEnrollment
              ? (e) => e.preventDefault()
              : handleSubmit
          }
        >
          {!showEnrollment && !mfaResolver && (
            <>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="Email"
                className={`${INPUT} mb-4`}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Password"
                className={`${INPUT} mb-4`}
              />
            </>
          )}

          {showEnrollment && totpSecret && (
            <div className="text-center">
              <div className="inline-block rounded-2xl border border-[#ececf3] bg-white p-4 shadow-[0_8px_24px_-12px_rgba(27,26,82,0.25)]">
                <QRCodeCanvas
                  value={totpSecret.generateQrCodeUrl(email, "Magis SuperAdmin")} size={172} fgColor="#1b1a52"
                />
              </div>
              <p className="mt-3 text-sm text-slate-600">Scan QR with Authenticator and enter OTP.</p>
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="6-digit code"
                className={`${INPUT_CODE} mt-4`}
              />
              <button
                type="button"
                onClick={handleEnroll}
                className={`${BTN_PRIMARY} mt-4`}
              >
                Enroll TOTP
              </button>
              {enrollSuccess && (
                <p className="text-emerald-600 mt-2">Enrollment successful! Reloading...</p>
              )}
            </div>
          )}

          {!showEnrollment && mfaResolver && (
            <div className="text-center">
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="Enter OTP"
                className={`${INPUT_CODE} mb-4`}
              />
              <button
                type="submit"
                className={BTN_PRIMARY}
              >
                Submit OTP
              </button>
            </div>
          )}

          {!showEnrollment && !mfaResolver && (
            <button
              type="submit"
              className={isLoading ? BTN_BUSY : BTN_PRIMARY}
              disabled={isLoading}
            >
              {isLoading ? "Logging in..." : "Log In"}
            </button>
          )}
        </form>
    </AuthShell>
  );
}

export default SuperAdminLogin;
