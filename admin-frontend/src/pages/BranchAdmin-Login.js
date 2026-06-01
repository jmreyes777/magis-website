//magis-project/admin-frontend/src/pages/BranchAdmin-Login.js

import React, { useEffect, useState, useContext } from "react";
import { useNavigate } from "react-router-dom";
import AuthContext from "../context/AuthContext"; // ✅ Import AuthContext
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
import {connectSocket} from "../components/Admin-Utils-socket";
import { useWakeLock } from "../utils/useWakeLock";

function BranchAdminLogin() {
  const { setIsAuthenticated, setUserRole, setAdminEmail } = useContext(AuthContext); // ✅ Extract AuthContext functions
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [mfaResolver, setMfaResolver] = useState(null);
  const [selectedMfaHint, setSelectedMfaHint] = useState(null);
  const [totpSecret, setTotpSecret] = useState(null);
  const [emailSent, setEmailSent] = useState(false);
  const [showTotpEnrollment, setShowTotpEnrollment] = useState(false);
  const [enrollmentSuccess, setEnrollmentSuccess] = useState(false);
  
  const navigate = useNavigate();

  const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const [keepAwake, setKeepAwake] = useState(false);
  useWakeLock(keepAwake);

  useEffect(() => {
    // 🔄 Reset for a truly fresh login:
    //    • clear socket-ownership
    //    • clear any fallback login info
    //    • clear any previously saved branch-chat cache
    localStorage.removeItem("activeSocketTabId");
    localStorage.removeItem("fallbackBranchEmail");
    localStorage.removeItem("fallbackBranchRole");
    localStorage.removeItem("fallbackBranchId");
    localStorage.removeItem("fallbackBranchName");
    // remove anything under branchChats-*
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("branchChats-")) {
        localStorage.removeItem(key);
      }
    });
    window.__SOCKET_CONNECTED = false;
    console.info("[LOGIN] Ownership cleared for fresh login.");
  
    // 🧪 Autofill (optional for testing)
    const savedEmail = localStorage.getItem("testBranchAdminEmail");
    const savedPassword = localStorage.getItem("testBranchAdminPassword");
    if (savedEmail) setEmail(savedEmail);
    if (savedPassword) setPassword(savedPassword);
  }, []); 

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    const auth = getAuth();
    const sanitizedEmail = email.trim().toLowerCase();
    const sanitizedPassword = password.trim();

    try {
        console.info("[INFO] Attempting login with email:", sanitizedEmail);

        if (!isValidEmail(sanitizedEmail)) {
            throw new Error("Please enter a valid email address.");
        }

        // ✅ Ensure reCAPTCHA site key is available
        const recaptchaSiteKey = process.env.REACT_APP_RECAPTCHA_SITE_KEY;
        if (!recaptchaSiteKey) {
            console.error("[ERROR] reCAPTCHA site key is missing. Check .env settings.");
            setError("Authentication service unavailable. Please try again later.");
            setIsLoading(false);
            return;
        }

        // ✅ Ensure reCAPTCHA is available
        if (!window.grecaptcha || !window.grecaptcha.execute) {
            console.warn("[WARNING] grecaptcha not available. Retrying in 1 second...");
            setTimeout(() => handleSubmit(e), 1000);
            setIsLoading(false);
            return;
        }

        // ✅ Get reCAPTCHA Token Before Login Attempt
        let recaptchaToken;
        try {
            recaptchaToken = await window.grecaptcha.execute(recaptchaSiteKey, { action: "login" });
            sessionStorage.setItem("recaptchaToken", recaptchaToken);
        } catch (recaptchaError) {
            console.error("[ERROR] Failed to get reCAPTCHA token:", recaptchaError.message);
            setError("reCAPTCHA verification failed. Please refresh and try again.");
            setIsLoading(false);
            return;
        }

        console.info("[SUCCESS] reCAPTCHA token obtained.");

        // ✅ Perform Firebase Authentication
        const userCredential = await signInWithEmailAndPassword(auth, sanitizedEmail, sanitizedPassword);
        const user = userCredential.user;
        console.info("[INFO] Firebase authentication successful:", user.email);

        // ✅ Ensure email is verified before allowing MFA
        if (!user.emailVerified) {
            if (!emailSent) {
                console.info("[EMAIL] Sending email verification...");
                await sendEmailVerification(user);
                setEmailSent(true);
                throw new Error("A verification email has been sent. Please verify before logging in again.");
            } else {
                throw new Error("Please verify your email before logging in.");
            }
        }

        const customClaims = await fetchCustomClaims(user);
        if (!customClaims || customClaims.role !== "branchadmin") {
            throw new Error("Access denied. You are not authorized as a Branch Admin.");
        }

        const enrolledFactors = user.multiFactor?.enrolledFactors || [];

        // ✅ If no MFA enrolled, start the TOTP enrollment process
        if (enrolledFactors.length === 0) {
            console.info("[MFA] No TOTP enrolled. Prompting enrollment...");

            const multiFactorSession = await multiFactor(user).getSession();
            const secret = await TotpMultiFactorGenerator.generateSecret(multiFactorSession);

            setTotpSecret(secret);
            setShowTotpEnrollment(true);
            return;
        }

        // ✅ If MFA is required, properly handle OTP input
        if (enrolledFactors.length > 0) {
            console.info("[MFA] Multi-factor authentication required. Preparing OTP UI...");

            try {
                const resolver = getMultiFactorResolver(auth, userCredential);
                setMfaResolver(resolver);

                const totpHint = resolver.hints.find((hint) => hint.factorId === TotpMultiFactorGenerator.FACTOR_ID);
                if (!totpHint) {
                    throw new Error("TOTP factor not found. Please use a valid second factor.");
                }

                setSelectedMfaHint(totpHint);

                // ✅ Ensure OTP input UI appears
                setShowTotpEnrollment(false);
                return;
            } catch (mfaError) {
                console.error("[ERROR] Failed to retrieve MFA resolver:", mfaError.message);
                setError("MFA Resolver setup failed. Please try again.");
                return;
            }
        }

        // ✅ If No MFA Required, Proceed With Login
        await finalizeLogin(user, customClaims);
    } catch (error) {
        if (error.code === "auth/multi-factor-auth-required") {
            console.info("[MFA] MFA Challenge Required!");

            try {
                const resolver = getMultiFactorResolver(auth, error);
                setMfaResolver(resolver);

                const totpHint = resolver.hints.find((hint) => hint.factorId === TotpMultiFactorGenerator.FACTOR_ID);
                if (!totpHint) {
                    throw new Error("TOTP factor not found. Please use a valid second factor.");
                }

                setSelectedMfaHint(totpHint);

                // ✅ Ensure OTP input UI appears
                setShowTotpEnrollment(false);
                return;
            } catch (resolverError) {
                console.error("[ERROR] MFA Resolver Setup Failed:", resolverError.message);
                setError("Failed to set up MFA resolver. Try again.");
                return;
            }
        }

        console.error("[ERROR] Login failed:", error.message);
        setError(error.message);

        // ✅ Force Refresh reCAPTCHA on Failure
        try {
            console.warn("[WARNING] Refreshing reCAPTCHA token due to failed login...");
            const newRecaptchaToken = await window.grecaptcha.execute(process.env.REACT_APP_RECAPTCHA_SITE_KEY, { action: "login" });
            sessionStorage.setItem("recaptchaToken", newRecaptchaToken);
        } catch (recaptchaError) {
            console.error("[ERROR] Failed to refresh reCAPTCHA:", recaptchaError.message);
        }
    } finally {
        setIsLoading(false);
    }
};

  const handleTotpVerification = async (e) => {
    e.preventDefault();
    setError("");

    if (!mfaResolver || !selectedMfaHint) {
      setError("MFA session expired. Please try logging in again.");
      return;
    }

    try {
      console.info("[MFA] Verifying TOTP code...");

      // ✅ Ensure we extract mfaEnrollmentId properly
      const mfaEnrollmentId = selectedMfaHint?.uid || selectedMfaHint?.mfaEnrollmentId;
      if (!mfaEnrollmentId) {
        throw new Error("MFA Enrollment ID is missing. Unable to verify OTP.");
      }

      // ✅ Use mfaEnrollmentId instead of selectedMfaHint.uid
      const multiFactorAssertion = TotpMultiFactorGenerator.assertionForSignIn(
        mfaEnrollmentId, // Correct parameter
        totpCode.trim()
      );

      // ✅ Resolve sign-in using MFA assertion
      const userCredential = await mfaResolver.resolveSignIn(multiFactorAssertion);
      console.info("[MFA] TOTP verification successful.");

      const customClaims = await fetchCustomClaims(userCredential.user);
      await finalizeLogin(userCredential.user, customClaims);
    } catch (error) {
      console.error("[ERROR] TOTP Verification failed:", error.message);
      setError("Invalid or expired TOTP code. Please try again.");
    }
};

const finalizeLogin = async (user, customClaims) => {
  console.info("[INFO] Finalizing login...");

  // 1️⃣ Get the Firebase ID token
  const firebaseToken = await user.getIdToken();
  const branchEmail   = user.email;

  // 2️⃣ Persist Firebase token in sessionStorage
  sessionStorage.setItem("branchAdminToken", firebaseToken);
  sessionStorage.setItem("branchAdminRole",  "branchadmin");
  sessionStorage.setItem("branchId",          customClaims.branchId);
  sessionStorage.setItem("branchEmail",       branchEmail);
  sessionStorage.setItem("branchName",        customClaims.branchName || "Branch Admin");

  // 3️⃣ Mirror into localStorage for cross‑tab sync
  localStorage.setItem("branchAdminToken", firebaseToken);
  localStorage.setItem("branchAdminRole",  "branchadmin");
  localStorage.setItem("branchId",          customClaims.branchId);
  localStorage.setItem("branchEmail",       branchEmail);
  localStorage.setItem("branchName",        customClaims.branchName || "Branch Admin");

  // 4️⃣ Generate and store MFA Session ID for session-level MFA tracking
  const mfaSessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  sessionStorage.setItem("mfaSessionId", mfaSessionId);
  
  // 5️⃣ Mark MFA as verified for this session (complements Firebase MFA)
  try {
    const token = sessionStorage.getItem("branchAdminToken") || firebaseToken;
    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/api/mfa/session-verify`,
      {
        method:  "POST",
        credentials: 'include',
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "X-Session-Id": mfaSessionId,
        },
      }
    );
    if (res.ok) {
      console.info("[MFA] Session verification recorded");
    }
  } catch (err) {
    console.warn("[MFA] Could not record session verification:", err);
  }

  // 6️⃣ Exchange for short‑lived HMAC fallback token
  try {
    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/api/issue-fallback-token`,
      {
        method:  "POST",
        credentials: 'include',
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ branchEmail }),
      }
    );
    const body = await res.json();
    if (res.ok && body.token) {
      sessionStorage.setItem("branchAdminToken", body.token);
      localStorage.setItem("branchAdminToken",   body.token);
      console.info("[LOGIN] Stored fallback HMAC token");
    } else {
      console.warn("[LOGIN] Could not fetch fallback token:", body.error);
    }
  } catch (err) {
    console.error("[LOGIN] Error issuing fallback token:", err);
  }

  // 7️⃣ Notify Service Worker of new token (ID token overwritten by fallback if present)
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SET_AUTH_TOKEN",
      token: sessionStorage.getItem("branchAdminToken")
    });
  }

  // 8️⃣ Ensure a per‑tab sessionTabId exists
  if (!sessionStorage.getItem("sessionTabId")) {
    const sessionTabId = `session-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
    sessionStorage.setItem("sessionTabId", sessionTabId);
    console.info("[LOGIN] ✅ Assigned new sessionTabId:", sessionTabId);
  }

  // 9️⃣ Ensure a shared tabId exists (used for socket ownership)
  let tabId = localStorage.getItem("tabId");
  if (!tabId) {
    tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    localStorage.setItem("tabId", tabId);
    console.info("[LOGIN] ✅ Assigned new tabId:", tabId);
  }

  // 🔟 Fallback values for multi‑tab restore
  localStorage.setItem("fallbackBranchEmail", customClaims.branchEmail || branchEmail);
  localStorage.setItem("fallbackBranchId",    customClaims.branchId);
  localStorage.setItem("fallbackBranchRole",  "branchadmin");
  localStorage.setItem("fallbackBranchName",  customClaims.branchName || "Branch Admin");

  // 1️⃣1️⃣ Dev autofill helpers
  localStorage.setItem("testBranchAdminEmail",    branchEmail);
  localStorage.setItem("testBranchAdminPassword", password);

  console.info("[SUCCESS] Branch Admin token stored successfully.");

  try {
    // 1️⃣2️⃣ Update React AuthContext
    setIsAuthenticated(true);
    setUserRole("branchadmin");
    setAdminEmail(branchEmail);

    // 1️⃣3️⃣ Delay socket connect until storage has settled
    setTimeout(() => {
      connectSocket(branchEmail);
      localStorage.setItem("activeSocketTabId", tabId);
    }, 100);

    // 1️⃣4️⃣ Navigate into the dashboard
    navigate("/admin/chats", {
      replace: true,
      state: {
        fromLogin:  true,
        branchId:   customClaims.branchId,
        branchEmail,
        branchName: customClaims.branchName || "Branch Admin",
      },
    });

    window.dispatchEvent(new Event("branchAdminAuthenticated"));
    
  } catch (err) {
    console.error("[ERROR] Navigation or socket connection failed:", err.message);
  }
};


  const handleEnrollTotp = async () => {
    if (!totpSecret || !totpCode) {
        setError("Please enter the OTP from the Authenticator App.");
        return;
    }

    try {
        console.info("[MFA] Enrolling TOTP...");

        const verificationCode = totpCode.trim();
        const multiFactorAssertion = TotpMultiFactorGenerator.assertionForEnrollment(
            totpSecret,
            verificationCode
        );

        await multiFactor(getAuth().currentUser).enroll(multiFactorAssertion, "Google Authenticator");

        console.info("[MFA] TOTP Enrollment successful!");

        // ✅ Show success message
        setEnrollmentSuccess(true);
        setError("");

        // Reset state after successful enrollment
        setTotpSecret(null);
        setTotpCode("");
        setShowTotpEnrollment(false);

        // Refresh UI to reflect enrollment
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    } catch (error) {
        console.error("[ERROR] TOTP Enrollment failed:", error.message);
        setError("Invalid or expired TOTP code. Please try again.");
    }
};
return (
  <div className="min-h-screen flex items-center justify-center bg-gray-100">
    <div className="p-8 bg-white shadow-lg rounded-lg w-96">
      <h1 className="text-2xl font-bold mb-6 text-center">Branch Admin Login</h1>

      {isLoading && (
        <p className="text-center text-blue-500">Processing...</p>
      )}

      {/* ← Generic error label */}
      {error && (
        <p className="text-red-500 text-center mb-4">
          {error}
        </p>
      )}

      <form
        onSubmit={mfaResolver ? handleTotpVerification : handleSubmit}
        noValidate
      >
        {emailSent && (
          <p className="text-blue-500 text-center mb-4">
            A verification email has been sent. Please check your email.
          </p>
        )}

        {/* 🔹 Email & Password */}
        {!showTotpEnrollment && !mfaResolver && (
          <>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2 border rounded-lg mb-2"
              placeholder="Enter your email"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2 border rounded-lg"
              placeholder="Enter your password"
            />
          </>
        )}

        {/* 🔹 TOTP Enrollment UI */}
        {showTotpEnrollment && totpSecret && (
          <div className="text-center">
            <QRCodeCanvas
              value={totpSecret.generateQrCodeUrl(email, "Magis Admin")}
              size={180}
            />
            <p className="text-sm mt-2">
              Scan the QR code with Google Authenticator and enter the OTP below.
            </p>

            <label
              htmlFor="enrollOtp"
              className="block text-sm font-medium text-gray-700 mt-4"
            >
              One-Time Passcode
            </label>
            <input
              id="enrollOtp"
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              className="w-full px-4 py-2 border rounded-lg mt-1"
              placeholder="Enter 6-digit OTP"
            />

            {enrollmentSuccess && (
              <p className="text-green-500 text-sm mt-2">
                ✅ TOTP Enrollment Successful! Redirecting...
              </p>
            )}

            <button
              type="button"
              onClick={handleEnrollTotp}
              className="w-full py-2 mt-4 bg-green-500 text-white rounded-lg"
            >
              Enroll TOTP
            </button>
          </div>
        )}

        {/* 🔹 MFA OTP */}
        {!showTotpEnrollment && mfaResolver && (
          <div className="text-center">
            <label
              htmlFor="mfaOtp"
              className="block text-sm font-medium text-gray-700"
            >
              One-Time Passcode
            </label>
            <input
              id="mfaOtp"
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              className="w-full px-4 py-2 border rounded-lg mt-1"
              placeholder="Enter 6-digit OTP"
            />
            <button
              type="button"
              onClick={handleTotpVerification}
              className="w-full py-2 mt-4 bg-green-500 text-white rounded-lg"
            >
              Submit OTP
            </button>
          </div>
        )}

        {/* 🔹 Log In Button */}
        {!showTotpEnrollment && !mfaResolver && (
          <button
            onClick={() => setKeepAwake(true)}
            type="submit"
            className="w-full py-2 mt-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Log In
          </button>
        )}
      </form>
    </div>
  </div>
);  
}

export default BranchAdminLogin;