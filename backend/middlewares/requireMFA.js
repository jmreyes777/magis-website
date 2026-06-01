/**
 * MFA Enforcement Middleware
 * Ensures MFA verification for sensitive operations
 */

const { db } = require('../utils/firebase');

const MFA_COLLECTION = 'mfa_enrollment';

/**
 * Middleware to check if MFA is enrolled and verified
 * Use this for routes that require MFA protection
 */
async function requireMFA(req, res, next) {
  try {
    // Skip if no user (should be caught by auth middleware first)
    if (!req.user || !req.user.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const email = req.user.email.toLowerCase();
    
    // Check if user has completed MFA enrollment
    const doc = await db.collection(MFA_COLLECTION).doc(email).get();
    
    if (!doc.exists) {
      return res.status(403).json({
        error: 'MFA enrollment required',
        code: 'MFA_REQUIRED',
        message: 'Multi-factor authentication must be set up before accessing sensitive data',
        setupRequired: true,
      });
    }
    
    const data = doc.data();
    
    if (!data.enrolled) {
      return res.status(403).json({
        error: 'MFA setup incomplete',
        code: 'MFA_INCOMPLETE',
        message: 'Please complete MFA verification to continue',
        setupRequired: true,
      });
    }
    
    // Check if MFA was verified in this session
    // This would typically be stored in session/JWT claims
    if (!req.user.mfaVerified) {
      return res.status(403).json({
        error: 'MFA verification required',
        code: 'MFA_VERIFY_REQUIRED',
        message: 'Please verify your MFA code to continue',
        verifyRequired: true,
      });
    }
    
    next();
  } catch (error) {
    console.error('[MFA Middleware] Error:', error);
    res.status(500).json({ error: 'MFA check failed' });
  }
}

/**
 * Middleware to check if MFA is enrolled (but not necessarily verified in this session)
 * Use this for less sensitive operations that just need MFA setup
 */
async function requireMFAEnrollment(req, res, next) {
  try {
    if (!req.user || !req.user.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const email = req.user.email.toLowerCase();
    
    const doc = await db.collection(MFA_COLLECTION).doc(email).get();
    
    if (!doc.exists || !doc.data().enrolled) {
      return res.status(403).json({
        error: 'MFA enrollment required',
        code: 'MFA_REQUIRED',
        setupRequired: true,
      });
    }
    
    next();
  } catch (error) {
    console.error('[MFA Middleware] Error:', error);
    res.status(500).json({ error: 'MFA check failed' });
  }
}

module.exports = {
  requireMFA,
  requireMFAEnrollment,
};
