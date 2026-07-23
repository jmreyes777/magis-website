/**
 * MFA Session Verification Modal
 *
 * Performs a genuine step-up authentication: when re-verification is required
 * (8-hour expiry OR a geolocation anomaly), the user must reauthenticate with
 * their password + a fresh TOTP code via Firebase. The resulting fresh Firebase
 * ID token is sent to the backend, which only (re)establishes the verified
 * session if the token proves a recent second-factor authentication.
 *
 * For DPA 2012 compliance: Re-verification required every 8 hours for chat access
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  getMultiFactorResolver,
  TotpMultiFactorGenerator,
} from 'firebase/auth';
import { jwtDecode } from 'jwt-decode';
import { auth } from '../firebase-config';

const MFASessionModal = ({ isOpen, onVerify, onCancel, operation = 'access chat with sensitive personal information' }) => {
  const [status, setStatus] = useState('checking'); // checking | verified | expired | needs-verification | error
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [error, setError] = useState(null);
  const [geoAnomaly, setGeoAnomaly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ── Email-OTP step-up (staff AND branch email-OTP accounts) ──────────
  // Neither has a Firebase TOTP factor, so the password+TOTP step-up below
  // can't work for them; detect the account kind from the token and use the
  // matching emailed-code step-up endpoints instead. authVia survives silent
  // token rotation (issue-fallback-token preserves provenance).
  const emailOtpKind = (() => {
    try {
      const t = sessionStorage.getItem('branchAdminToken') || localStorage.getItem('branchAdminToken');
      if (!t) return null;
      const d = jwtDecode(t);
      if (d.authVia === 'branch_email_otp') return 'branch';
      if (d.staff === true || d.authVia === 'staff_email_otp') return 'staff';
      return null;
    } catch {
      return null;
    }
  })();
  const isStaff = emailOtpKind !== null; // email-OTP UI (staff or branch)
  const stepupBase = emailOtpKind === 'branch' ? '/api/branch/stepup' : '/api/staff/stepup';
  const [staffCode, setStaffCode] = useState('');
  const [staffSent, setStaffSent] = useState(false);
  const [staffResendIn, setStaffResendIn] = useState(0);
  const staffRequestedRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      checkSessionStatus();
    }
  }, [isOpen]);

  const checkSessionStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const token = sessionStorage.getItem('branchAdminToken') || 
                   localStorage.getItem('branchAdminToken');
      
      const sessionId = generateSessionId();
      
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/session-status`, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'X-Session-Id': sessionId,
        },
        credentials: 'include',
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to check MFA status');
      }
      
      if (!data.enrolled) {
        setStatus('not-enrolled');
        setError('MFA not enrolled. Please complete MFA setup in your profile first.');
      } else if (data.verified) {
        setStatus('verified');
        setTimeRemaining(data.timeRemainingMinutes);
        // Auto-verify if already verified
        onVerify({ timeRemaining: data.timeRemainingMinutes });
      } else if (data.expired) {
        setStatus('expired');
        setError('Your MFA session has expired. Please re-authenticate.');
      } else if (data.geoAnomaly) {
        setStatus('needs-verification');
        setGeoAnomaly(true);
        setError(data.message || 'Location change detected. Please re-verify your identity.');
      } else {
        setStatus('needs-verification');
        setGeoAnomaly(false);
      }
    } catch (err) {
      console.error('[MFA Session] Error:', err);
      setStatus('error');
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const authToken = () =>
    sessionStorage.getItem('branchAdminToken') || localStorage.getItem('branchAdminToken');

  // Email-OTP step-up: email a fresh 6-digit code, then verify it. The backend
  // (/api/staff/stepup/* or /api/branch/stepup/*) writes a fresh 8h MFA session
  // keyed by the same X-Session-Id the dashboard polls, so chat access resumes
  // immediately.
  const requestStaffCode = async () => {
    setError(null);
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}${stepupBase}/request`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken()}`,
          'X-Session-Id': generateSessionId(),
        },
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not send the code. Please try again.');
        if (res.status === 429 && data.retryAfterSec) setStaffResendIn(data.retryAfterSec);
        return;
      }
      setStaffSent(true);
      setStaffResendIn(45);
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  const verifyStaffCode = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}${stepupBase}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken()}`,
          'X-Session-Id': generateSessionId(),
        },
        credentials: 'include',
        body: JSON.stringify({ code: staffCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Verification failed.');
        setStaffCode('');
        return;
      }
      setStatus('verified');
      setStaffCode('');
      onVerify(data);
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Reset staff step-up state when the modal closes.
  useEffect(() => {
    if (!isOpen) {
      staffRequestedRef.current = false;
      setStaffSent(false);
      setStaffCode('');
      setStaffResendIn(0);
    }
  }, [isOpen]);

  // Resend cooldown ticker.
  useEffect(() => {
    if (staffResendIn <= 0) return;
    const t = setInterval(() => setStaffResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [staffResendIn]);

  // Auto-email a code as soon as a staffer needs to re-verify.
  useEffect(() => {
    if (
      isOpen && isStaff && !staffRequestedRef.current &&
      (status === 'needs-verification' || status === 'expired')
    ) {
      staffRequestedRef.current = true;
      requestStaffCode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isStaff, status]);

  // Send a freshly-minted Firebase ID token (post-reauth) to the backend so it
  // can (re)establish the verified session. The backend rejects stale tokens.
  const submitFreshToken = async (user) => {
    const freshToken = await user.getIdToken(true);
    const sessionId = generateSessionId();

    const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/session-verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freshToken}`,
        'X-Session-Id': sessionId,
      },
      credentials: 'include',
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || data.error || 'Verification failed');
    }

    setStatus('verified');
    setPassword('');
    setTotpCode('');
    onVerify(data);
  };

  // Genuine step-up: reauthenticate (password) -> resolve TOTP -> fresh token.
  const verifySession = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitting(true);
    setError(null);

    const user = auth.currentUser;
    const email = user?.email || sessionStorage.getItem('branchEmail');

    if (!user || !email) {
      setError('Your login session is no longer active. Please sign in again.');
      setSubmitting(false);
      return;
    }

    if (!password || totpCode.trim().length < 6) {
      setError('Enter your password and the 6-digit code from your authenticator app.');
      setSubmitting(false);
      return;
    }

    try {
      // First factor: reauthenticate with password. Firebase will throw
      // multi-factor-auth-required, handing us a resolver for the TOTP step.
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, password));
      // If no second factor was required (unexpected), the token is already fresh.
      await submitFreshToken(user);
    } catch (err) {
      if (err.code === 'auth/multi-factor-auth-required') {
        try {
          const resolver = getMultiFactorResolver(auth, err);
          const totpHint = resolver.hints.find(
            (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID
          );
          if (!totpHint) {
            throw new Error('No authenticator app is enrolled for this account.');
          }
          const enrollmentId = totpHint.uid || totpHint.mfaEnrollmentId;
          const assertion = TotpMultiFactorGenerator.assertionForSignIn(
            enrollmentId,
            totpCode.trim()
          );
          const cred = await resolver.resolveSignIn(assertion);
          await submitFreshToken(cred.user);
        } catch (mfaErr) {
          console.error('[MFA Session] Step-up failed:', mfaErr);
          setError(
            mfaErr.code === 'auth/invalid-verification-code'
              ? 'Invalid authenticator code. Please try again.'
              : mfaErr.message || 'Verification failed. Please try again.'
          );
        }
      } else if (
        err.code === 'auth/wrong-password' ||
        err.code === 'auth/invalid-credential' ||
        err.code === 'auth/invalid-login-credentials'
      ) {
        setError('Incorrect password. Please try again.');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Too many attempts. Please wait a moment and try again.');
      } else {
        console.error('[MFA Session] Reauth error:', err);
        setError(err.message || 'Verification failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const extendSession = async () => {
    try {
      setLoading(true);
      
      const token = sessionStorage.getItem('branchAdminToken') || 
                   localStorage.getItem('branchAdminToken');
      
      const sessionId = generateSessionId();
      
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/extend-session`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Session-Id': sessionId,
        },
        credentials: 'include',
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to extend session');
      }
      
      onVerify(data);
    } catch (err) {
      console.error('[MFA Session] Extend error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Generate a session ID based on browser fingerprint + timestamp
  const generateSessionId = () => {
    const existing = sessionStorage.getItem('mfaSessionId');
    if (existing) return existing;
    
    const newId = `sess_${Date.now()}_${crypto.randomUUID()}`;
    sessionStorage.setItem('mfaSessionId', newId);
    return newId;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-center mb-4">
          <div className="bg-blue-100 p-3 rounded-full">
            <svg 
              viewBox="0 0 24 24" 
              width="32" 
              height="32" 
              fill="#2563EB"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
        </div>
        
        <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
          Security Verification
        </h2>
        
        <p className="text-gray-600 text-center mb-4 text-sm">
          Multi-factor authentication verification is required to {operation}.
          This protects sensitive personal information under DPA 2012.
        </p>

        {/* Loading */}
        {loading && (
          <div className="text-center py-4">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-gray-600">Checking MFA status...</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-3 py-2 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        {/* Already Verified */}
        {status === 'verified' && !loading && (
          <div className="text-center">
            <div className="bg-green-100 text-green-700 px-4 py-2 rounded mb-4">
              ✓ MFA verified for this session
              {timeRemaining && (
                <p className="text-sm mt-1">
                  Session valid for {timeRemaining} more minutes
                </p>
              )}
            </div>
            <button
              onClick={extendSession}
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
              disabled={loading}
            >
              Continue to Chat
            </button>
          </div>
        )}

        {/* Needs Verification / Expired -> staff email-OTP step-up */}
        {(status === 'needs-verification' || status === 'expired') && !loading && isStaff && (
          <form onSubmit={verifyStaffCode} className="text-center">
            <div className="bg-yellow-50 border border-yellow-400 text-yellow-800 px-3 py-2 rounded mb-4 text-sm">
              {geoAnomaly ? (
                <>
                  <p className="font-medium">New Sign-in Location Detected</p>
                  <p>Your session is being accessed from a different location.</p>
                  <p className="mt-1">Enter the code we emailed you to continue.</p>
                </>
              ) : (
                <>
                  <p className="font-medium">Re-verification Required</p>
                  <p>Your previous verification has expired.</p>
                  <p className="mt-1">Enter the 6-digit code we emailed you to continue.</p>
                </>
              )}
            </div>

            <div className="text-left mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Email code</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={staffCode}
                onChange={(e) => setStaffCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoComplete="one-time-code"
                autoFocus
                className="w-full border border-gray-300 rounded px-3 py-2 tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="6-digit code"
                disabled={submitting}
              />
            </div>

            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 mb-2 disabled:opacity-60"
              disabled={submitting || staffCode.length !== 6}
            >
              {submitting ? 'Verifying...' : 'Verify & continue'}
            </button>

            <button
              type="button"
              onClick={requestStaffCode}
              disabled={staffResendIn > 0}
              className="w-full text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
            >
              {staffResendIn > 0 ? `Resend code in ${staffResendIn}s` : (staffSent ? 'Resend code' : 'Email me a code')}
            </button>

            <p className="text-xs text-gray-500 mt-2">
              A 6-digit code was emailed to your address. It expires shortly.
            </p>
          </form>
        )}

        {/* Needs Verification / Expired -> genuine step-up (Firebase admins) */}
        {(status === 'needs-verification' || status === 'expired') && !loading && !isStaff && (
          <form onSubmit={verifySession} className="text-center">
            <div className="bg-yellow-50 border border-yellow-400 text-yellow-800 px-3 py-2 rounded mb-4 text-sm">
              {geoAnomaly ? (
                <>
                  <p className="font-medium">New Sign-in Location Detected</p>
                  <p>Your session is being accessed from a different country.</p>
                  <p className="mt-1">For your security, please re-verify your identity below.</p>
                </>
              ) : (
                <>
                  <p className="font-medium">Re-verification Required</p>
                  <p>Your previous MFA verification has expired.</p>
                  <p className="mt-1">Please re-verify your identity below to continue.</p>
                </>
              )}
            </div>

            <div className="text-left mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter your password"
                disabled={submitting}
              />
            </div>

            <div className="text-left mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Authenticator code</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                autoComplete="one-time-code"
                className="w-full border border-gray-300 rounded px-3 py-2 tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="6-digit code"
                disabled={submitting}
              />
            </div>

            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 mb-3 disabled:opacity-60"
              disabled={submitting}
            >
              {submitting ? 'Verifying...' : 'Verify Identity'}
            </button>

            <p className="text-xs text-gray-500">
              Enter your password and the current 6-digit code from your Google Authenticator,
              Authy, or Microsoft Authenticator app.
            </p>
          </form>
        )}

        {/* Not Enrolled */}
        {status === 'not-enrolled' && !loading && (
          <div className="text-center">
            <div className="bg-orange-100 border border-orange-400 text-orange-700 px-3 py-2 rounded mb-4 text-sm">
              <p className="font-medium">MFA Not Set Up</p>
              <p>You need to complete MFA enrollment before accessing chat.</p>
            </div>
            
            <button
              onClick={() => window.location.href = '/profile?setupMFA=true'}
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 mb-3"
            >
              Go to Profile to Set Up MFA
            </button>
          </div>
        )}

        {/* Actions */}
        {!loading && status !== 'verified' && (
          <div className="flex gap-3 mt-4">
            <button
              onClick={onCancel}
              className="flex-1 bg-gray-200 text-gray-700 py-2 rounded hover:bg-gray-300"
              disabled={loading}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Info */}
        <p className="text-xs text-gray-500 text-center mt-4">
          Protected by multi-factor authentication for your account's security.
        </p>
      </div>
    </div>
  );
};

export default MFASessionModal;
