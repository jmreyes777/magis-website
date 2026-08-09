/**
 * MFA Routes
 * Session-based MFA enforcement that works WITH Firebase MFA
 * 
 * This implementation complements Firebase Auth MFA:
 * - Firebase MFA handles initial login authentication
 * - This system tracks session-level MFA verification for sensitive operations
 */

const express = require('express');
const router = express.Router();
const { db } = require('../utils/firebase');
const { getAuth } = require('firebase-admin/auth'); // v14: namespace API removed
const authenticateBranchAdmin = require('../middlewares/authenticateBranchAdmin');
const {
  getClientGeo,
  isInternationalChange,
  logGeoAnomaly,
  GEO_ANOMALY_MODE,
} = require('../utils/geoSecurity');

// MFA session tracking collection
const MFA_SESSION_COLLECTION = 'mfa_sessions';

// Maximum age (seconds) of the Firebase auth_time for a token to count as a
// fresh step-up. The client must perform a real MFA reauthentication within
// this window before session-verify will (re)establish the verified session.
const STEP_UP_MAX_AGE_SEC = Number(process.env.STEP_UP_MAX_AGE_SEC || 300);
// Small tolerance so minor client/server clock drift never rejects a valid step-up.
const CLOCK_SKEW_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || 30);

/**
 * True only when the presented Firebase ID token proves a RECENT TOTP
 * second-factor authentication. HMAC fallback tokens (no auth_time / firebase
 * claims) never satisfy this, forcing a genuine Firebase reauth for step-up.
 */
function hasFreshSecondFactor(decoded, maxAgeSec) {
  if (!decoded) return false;
  const secondFactor = decoded.firebase && decoded.firebase.sign_in_second_factor;
  const authTime = typeof decoded.auth_time === 'number' ? decoded.auth_time : null;
  if (secondFactor !== 'totp' || authTime === null) return false;
  const ageSec = Math.floor(Date.now() / 1000) - authTime;
  return ageSec >= -CLOCK_SKEW_SEC && ageSec <= maxAgeSec;
}

/**
 * POST /api/mfa/session-verify - Mark MFA as verified for this session
 * Called after successful Firebase MFA login
 */
router.post('/session-verify', authenticateBranchAdmin, async (req, res) => {
  try {
    const email = req.user.email.toLowerCase();
    const sessionId = req.headers['x-session-id'] || req.user.uid;
    const { ip, country } = getClientGeo(req);

    // Step-up enforcement: only establish/clear a verified session when the
    // caller presents a Firebase ID token from a RECENT TOTP reauthentication.
    // This makes the re-verification a genuine proof-of-possession rather than
    // a soft gate that any valid session token could clear.
    if (!hasFreshSecondFactor(req.user, STEP_UP_MAX_AGE_SEC)) {
      console.warn(`[MFA] Step-up required for ${email} (stale/non-MFA token).`);
      return res.status(401).json({
        error: 'step_up_required',
        stepUpRequired: true,
        message: 'Please re-verify with your authenticator app to continue.',
      });
    }

    // Store MFA verification timestamp for this session. The `country` captured
    // here is the session's geo baseline; re-verifying after a legitimate move
    // resets it and clears any prior geo lock.
    await db.collection(MFA_SESSION_COLLECTION).doc(`${email}_${sessionId}`).set({
      email,
      sessionId,
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // 8 hours
      ip: ip || (req.ip || req.connection.remoteAddress),
      country: country || null,
      geoLocked: false,
      userAgent: req.headers['user-agent'],
    });
    
    res.json({
      success: true,
      mfaVerified: true,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.error('[MFA Session] Verify error:', error);
    res.status(500).json({ error: 'Failed to record MFA verification' });
  }
});

/**
 * GET /api/mfa/session-status - Check if MFA is verified for current session
 */
router.get('/session-status', authenticateBranchAdmin, async (req, res) => {
  try {
    const email = (req.user.email || req.branchEmail || '').toLowerCase();
    const sessionId = req.headers['x-session-id'] || req.user.uid || email;
    
    // Check if Firebase user has MFA enrolled.
    // Staff (email-OTP) accounts have no Firebase user — their second factor is
    // the emailed code, so treat them as "enrolled" and skip the Firebase lookup
    // (which would throw for a non-Firebase uid). Existing Firebase admins are
    // unaffected.
    let mfaEnrolled;
    if (req.user && req.user.staff === true) {
      mfaEnrolled = true;
    } else {
      try {
        // Fallback (HMAC) tokens have no Firebase `uid`, so look up by email in that case.
        const userRecord = req.user.uid
          ? await getAuth().getUser(req.user.uid)
          : await getAuth().getUserByEmail(email);
        const enrolledFactors = userRecord.multiFactor?.enrolledFactors || [];
        mfaEnrolled = enrolledFactors.length > 0;
      } catch (lookupErr) {
        // Branch admins on the password + email-OTP system have NO Firebase Auth
        // user, so getUser/getUserByEmail throws auth/user-not-found. Like staff,
        // their second factor is the emailed OTP, so treat them as enrolled and let
        // the mfa_sessions check below decide verification — never hard-500 here.
        if (lookupErr && lookupErr.code === 'auth/user-not-found') {
          mfaEnrolled = true;
        } else {
          throw lookupErr;
        }
      }
    }
    
    if (!mfaEnrolled) {
      return res.json({
        enrolled: false,
        verified: false,
        required: true,
        message: 'MFA enrollment required',
      });
    }
    
    // Check session-level MFA verification
    const sessionDoc = await db.collection(MFA_SESSION_COLLECTION).doc(`${email}_${sessionId}`).get();
    
    if (!sessionDoc.exists) {
      return res.json({
        enrolled: true,
        verified: false,
        required: true,
        message: 'MFA verification required for this session',
      });
    }
    
    const sessionData = sessionDoc.data();
    const now = new Date();
    const expiresAt = new Date(sessionData.expiresAt);
    
    // Check if session MFA has expired (8 hours)
    if (now > expiresAt) {
      return res.json({
        enrolled: true,
        verified: false,
        expired: true,
        required: true,
        message: 'MFA verification expired, please re-verify',
      });
    }
    
    // ── Geolocation anomaly detection ────────────────────────────────────────
    // If the current request's country differs from the session's baseline
    // country (an international move mid-session), record it. In "enforce" mode
    // we force MFA re-verification; in "monitor" mode we only log (no lock).
    const { ip, country } = getClientGeo(req);
    const enforce = GEO_ANOMALY_MODE === 'enforce';
    if (isInternationalChange(sessionData.country, country)) {
      // Log only once per detected destination country to avoid poll spam.
      if (sessionData.geoFlaggedTo !== country) {
        await logGeoAnomaly({
          email,
          sessionId,
          fromCountry: sessionData.country,
          toCountry: country,
          ip,
          userAgent: req.headers['user-agent'],
        });
        await db.collection(MFA_SESSION_COLLECTION).doc(`${email}_${sessionId}`).update({
          geoFlaggedTo: country || null,
          geoFlaggedAt: new Date().toISOString(),
          geoFlaggedFrom: sessionData.country || null,
          geoLocked: enforce, // only lock the session when enforcing
        });
      }
      if (enforce) {
        return res.json({
          enrolled: true,
          verified: false,
          required: true,
          geoAnomaly: true,
          message: 'Location change detected. Please re-verify your identity.',
        });
      }
      // monitor mode → fall through and report the session as verified
    }

    // A previously triggered geo lock keeps the session unverified until the
    // admin re-verifies (which resets the baseline and clears the lock).
    if (sessionData.geoLocked) {
      return res.json({
        enrolled: true,
        verified: false,
        required: true,
        geoAnomaly: true,
        message: 'Location change detected. Please re-verify your identity.',
      });
    }

    // Calculate time remaining
    const timeRemaining = Math.floor((expiresAt - now) / 1000 / 60); // minutes
    
    res.json({
      enrolled: true,
      verified: true,
      required: true,
      expiresAt: sessionData.expiresAt,
      timeRemainingMinutes: timeRemaining,
    });
  } catch (error) {
    console.error('[MFA Session] Status error:', error);
    res.status(500).json({ error: 'Failed to check MFA status' });
  }
});

/**
 * POST /api/mfa/extend-session - Extend MFA verification for current session
 * Used when admin continues working with SPI
 */
router.post('/extend-session', authenticateBranchAdmin, async (req, res) => {
  try {
    const email = req.user.email.toLowerCase();
    const sessionId = req.headers['x-session-id'] || req.user.uid;
    
    // Verify current session is valid
    const sessionDoc = await db.collection(MFA_SESSION_COLLECTION).doc(`${email}_${sessionId}`).get();
    
    if (!sessionDoc.exists) {
      return res.status(403).json({
        error: 'No active MFA session found',
        mfaRequired: true,
      });
    }
    
    // Extend by another 8 hours
    const newExpiry = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await db.collection(MFA_SESSION_COLLECTION).doc(`${email}_${sessionId}`).update({
      expiresAt: newExpiry.toISOString(),
      extendedAt: new Date().toISOString(),
    });
    
    res.json({
      success: true,
      extended: true,
      expiresAt: newExpiry.toISOString(),
    });
  } catch (error) {
    console.error('[MFA Session] Extend error:', error);
    res.status(500).json({ error: 'Failed to extend MFA session' });
  }
});

/**
 * POST /api/mfa/clear-session - Clear MFA verification (logout)
 */
router.post('/clear-session', authenticateBranchAdmin, async (req, res) => {
  try {
    const email = req.user.email.toLowerCase();
    const sessionId = req.headers['x-session-id'] || req.user.uid;
    
    await db.collection(MFA_SESSION_COLLECTION).doc(`${email}_${sessionId}`).delete();
    
    res.json({ success: true, cleared: true });
  } catch (error) {
    console.error('[MFA Session] Clear error:', error);
    // Don't return error on logout
    res.json({ success: true });
  }
});

/**
 * GET /api/mfa/enrollment-status - Check if user has Firebase MFA enrolled
 */
router.get('/enrollment-status', authenticateBranchAdmin, async (req, res) => {
  try {
    // Staff (email-OTP) accounts have no Firebase user; report email-OTP as the
    // enrolled factor instead of calling getUser (which would throw).
    if (req.user && req.user.staff === true) {
      return res.json({
        enrolled: true,
        factors: [{ factorId: 'email_otp', displayName: 'Email code' }],
        required: true,
      });
    }
    const userRecord = await getAuth().getUser(req.user.uid);
    const enrolledFactors = userRecord.multiFactor?.enrolledFactors || [];
    
    res.json({
      enrolled: enrolledFactors.length > 0,
      factors: enrolledFactors.map(f => ({ 
        factorId: f.factorId, 
        displayName: f.displayName 
      })),
      required: true,
    });
  } catch (error) {
    console.error('[MFA] Enrollment status error:', error);
    res.status(500).json({ error: 'Failed to check enrollment status' });
  }
});

module.exports = router;
