/**
 * MFA (Multi-Factor Authentication) Utilities
 * TOTP-based MFA for Philippine DPA 2012 compliance
 * 
 * Features:
 * - TOTP generation/verification
 * - Backup codes
 * - Encrypted secret storage
 */

const crypto = require('crypto');

// TOTP configuration
const TOTP_CONFIG = {
  digits: 6,
  step: 30, // 30-second time step
  window: 1, // Allow 1 step before/after for time drift
  algorithm: 'sha1',
};

/**
 * Constant-time string comparison (P3-3). Avoids the timing side-channel of
 * `===`/`.includes`, which short-circuit on the first differing byte and can
 * leak how much of a secret an attacker guessed correctly. Returns false on any
 * length mismatch (lengths here are fixed: 6-digit TOTP, 64-char SHA-256 hex).
 */
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generate a random base32 secret for TOTP
 */
function generateSecret() {
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

/**
 * Generate TOTP URI for QR code
 */
function generateTOTPURI(secret, email, issuer = 'Magis Pawnshop') {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedEmail = encodeURIComponent(email);
  return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=${TOTP_CONFIG.algorithm}&digits=${TOTP_CONFIG.digits}&period=${TOTP_CONFIG.step}`;
}

/**
 * Generate backup codes (single-use recovery codes)
 */
function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // P3-3: 64 bits of entropy (8 random bytes -> 16 uppercase hex chars). The
    // previous 4-byte/32-bit codes were feasibly brute-forceable; 64 bits is the
    // floor for a single-use recovery secret.
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    codes.push(code);
  }
  return codes;
}

/**
 * Verify a TOTP code
 * @param {string} secret - Base32 encoded secret
 * @param {string} token - 6-digit code from user
 * @returns {boolean}
 */
function verifyTOTP(secret, token) {
  try {
    // P3-3: compare against every token in the allowed drift window using a
    // constant-time comparison and WITHOUT early-exit, so neither the expected
    // code nor which time-step matched can leak through response timing. The
    // i === 0 iteration covers the exact (current-step) match.
    let matched = false;
    for (let i = -TOTP_CONFIG.window; i <= TOTP_CONFIG.window; i++) {
      const windowToken = generateTOTP(secret, i * TOTP_CONFIG.step);
      if (constantTimeEqual(token, windowToken)) matched = true;
    }
    return matched;
  } catch (error) {
    console.error('[MFA] Verification error:', error);
    return false;
  }
}

/**
 * Generate TOTP for a specific time offset
 */
function generateTOTP(secret, timeOffset = 0) {
  const secretBytes = base32Decode(secret);
  const timeStep = Math.floor((Date.now() / 1000 + timeOffset) / TOTP_CONFIG.step);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(timeStep), 0);
  
  const hmac = crypto.createHmac(TOTP_CONFIG.algorithm, secretBytes);
  hmac.update(timeBuffer);
  const hash = hmac.digest();
  
  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const code = ((hash[offset] & 0x7f) << 24 |
                (hash[offset + 1] & 0xff) << 16 |
                (hash[offset + 2] & 0xff) << 8 |
                (hash[offset + 3] & 0xff)) % Math.pow(10, TOTP_CONFIG.digits);
  
  return code.toString().padStart(TOTP_CONFIG.digits, '0');
}

/**
 * Hash backup code for storage
 */
function hashBackupCode(code) {
  // Normalize before hashing: uppercase + strip any separators/whitespace, so a
  // user can enter the code with or without spacing/dashes. Existing 8-char hex
  // codes contain no separators, so their hashes are UNCHANGED (backward
  // compatible with already-stored backup codes).
  const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Verify a backup code
 * @param {string} code - Code entered by user
 * @param {string[]} hashedCodes - Array of hashed backup codes
 * @returns {boolean}
 */
function verifyBackupCode(code, hashedCodes) {
  const hashedInput = hashBackupCode(code);
  // P3-3: constant-time membership check with no early-exit over the stored
  // hashes (compares hash-vs-hash, so all entries are the same fixed length).
  let matched = false;
  for (const stored of Array.isArray(hashedCodes) ? hashedCodes : []) {
    if (constantTimeEqual(hashedInput, stored)) matched = true;
  }
  return matched;
}

/**
 * Base32 encoding
 */
function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  
  return output;
}

/**
 * Base32 decoding
 */
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const charMap = {};
  for (let i = 0; i < alphabet.length; i++) {
    charMap[alphabet[i]] = i;
  }
  
  let bits = 0;
  let value = 0;
  const output = [];
  
  str = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  
  for (let i = 0; i < str.length; i++) {
    value = (value << 5) | charMap[str[i]];
    bits += 5;
    
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  
  return Buffer.from(output);
}

/**
 * Encrypt MFA secret for database storage
 */
function encryptSecret(secret, encryptionKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

/**
 * Decrypt MFA secret from database
 */
function decryptSecret(encryptedData, encryptionKey) {
  const { encrypted, iv, authTag } = encryptedData;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = {
  generateSecret,
  generateTOTPURI,
  generateBackupCodes,
  verifyTOTP,
  generateTOTP,
  hashBackupCode,
  verifyBackupCode,
  encryptSecret,
  decryptSecret,
  TOTP_CONFIG,
};
