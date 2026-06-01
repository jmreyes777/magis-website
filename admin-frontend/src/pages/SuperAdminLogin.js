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
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="p-8 bg-white shadow-lg rounded-lg w-96">
        <h1 className="text-2xl font-bold mb-6 text-center">Super Admin Login</h1>
        {error && <p className="text-red-500 text-center mb-4">{error}</p>}
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
                className="w-full px-4 py-2 border rounded-lg mb-4"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Password"
                className="w-full px-4 py-2 border rounded-lg mb-4"
              />
            </>
          )}

          {showEnrollment && totpSecret && (
            <div className="text-center">
              <QRCodeCanvas
                value={totpSecret.generateQrCodeUrl(email, "Magis SuperAdmin")} size={180}
              />
              <p className="mt-2">Scan QR with Authenticator and enter OTP.</p>
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="6-digit code"
                className="w-full px-4 py-2 border rounded-lg mt-4"
              />
              <button
                type="button"
                onClick={handleEnroll}
                className="w-full py-2 bg-green-500 text-white rounded-lg mt-4"
              >
                Enroll TOTP
              </button>
              {enrollSuccess && (
                <p className="text-green-500 mt-2">Enrollment successful! Reloading...</p>
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
                className="w-full px-4 py-2 border rounded-lg mb-4"
              />
              <button
                type="submit"
                className="w/full py-2 bg-blue-600 text-white rounded-lg"
              >
                Submit OTP
              </button>
            </div>
          )}

          {!showEnrollment && !mfaResolver && (
            <button
              type="submit"
              className="w/full py-2 bg-blue-600 text-white rounded-lg"
              disabled={isLoading}
            >
              {isLoading ? "Logging in..." : "Log In"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

export default SuperAdminLogin;
