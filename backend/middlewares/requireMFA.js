/**
 * MFA Enforcement Middleware
 * ---------------------------------------------------------------------------
 * Server-side gate for endpoints that expose sensitive personal information
 * (SPI). It requires an ACTIVE MFA session for the authenticated branch admin.
 *
 * The session is established by POST /api/mfa/session-verify (routes/mfa.js)
 * ONLY after a fresh Firebase TOTP second-factor step-up. It is stored in the
 * `mfa_sessions` collection as `${email}_${sessionId}` with an 8h expiry and a
 * `geoLocked` flag that is set on international location anomalies.
 *
 * IMPORTANT: this must run AFTER authenticateBranchAdmin, which populates
 * req.user / req.branchEmail. (P0-2)
 */

const { db } = require('../utils/firebase');

const MFA_SESSION_COLLECTION = 'mfa_sessions';

// On an unexpected error (e.g. a transient Firestore blip) we fail OPEN so a
// legitimately-verified admin is never ejected by an infrastructure hiccup —
// matching the dashboard's session-status soft-pass behavior. Set
// MFA_FAIL_OPEN=false to fail closed (stricter; recommended once stable).
const MFA_FAIL_OPEN = String(process.env.MFA_FAIL_OPEN || 'true') !== 'false';

function isSessionActive(data) {
  if (!data || data.geoLocked === true) return false;
  const expMs = data.expiresAt ? new Date(data.expiresAt).getTime() : 0;
  return Number.isFinite(expMs) && expMs > Date.now();
}

// True when the admin has at least one active (non-expired, non-geo-locked)
// MFA session. Uses the exact session document when the client sends its
// X-Session-Id, otherwise falls back to any active session for the email so
// existing data fetches (which do not send the header) are not broken.
async function hasActiveMfaSession(email, sessionId) {
  if (sessionId) {
    const doc = await db
      .collection(MFA_SESSION_COLLECTION)
      .doc(`${email}_${sessionId}`)
      .get();
    if (doc.exists && isSessionActive(doc.data())) return true;
  }
  const snap = await db
    .collection(MFA_SESSION_COLLECTION)
    .where('email', '==', email)
    .get();
  return snap.docs.some((d) => isSessionActive(d.data()));
}

/**
 * Require an active MFA session to access SPI. Returns 403 MFA_VERIFY_REQUIRED
 * when none exists, which the admin dashboard already handles by opening the
 * step-up modal (it also polls session-status every 60s).
 */
async function requireMFA(req, res, next) {
  const email = ((req.user && req.user.email) || req.branchEmail || '').toLowerCase();
  if (!email) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const sessionId = req.headers['x-session-id'];
    if (await hasActiveMfaSession(email, sessionId)) {
      return next();
    }
    return res.status(403).json({
      error: 'MFA verification required',
      code: 'MFA_VERIFY_REQUIRED',
      message: 'Please verify your identity with your authenticator app to access this data.',
      verifyRequired: true,
    });
  } catch (error) {
    console.error('[MFA] requireMFA check failed:', error.message);
    if (MFA_FAIL_OPEN) {
      console.warn('[MFA] ⚠️ Failing OPEN on a transient error (set MFA_FAIL_OPEN=false to fail closed).');
      return next();
    }
    return res.status(503).json({ error: 'MFA verification temporarily unavailable. Please retry.' });
  }
}

// Backwards-compatible alias: an active session only exists after a real TOTP
// step-up, so enrollment is implied by the same check.
const requireMFAEnrollment = requireMFA;

module.exports = {
  requireMFA,
  requireMFAEnrollment,
};
