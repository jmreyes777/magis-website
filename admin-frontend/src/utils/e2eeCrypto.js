/**
 * End-to-End Encryption (E2EE) Utilities - Admin Frontend
 * Uses Web Crypto API with ECDH (P-256) + AES-256-GCM
 * 
 * For Philippine pawnshop SPI protection under DPA 2012
 */

const EC_CURVE = "P-256";
const AES_ALGORITHM = "AES-GCM";
const AES_LENGTH = 256;
const AES_IV_LENGTH = 12; // 96 bits for GCM
const AES_TAG_LENGTH = 128; // 128 bit authentication tag

/**
 * Generate a new ECDH key pair for this session
 */
export async function generateKeyPair() {
  return await window.crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: EC_CURVE,
    },
    true, // extractable
    ["deriveKey"]
  );
}

/**
 * Export public key to base64 for transmission
 */
export async function exportPublicKey(publicKey) {
  const exported = await window.crypto.subtle.exportKey("spki", publicKey);
  return arrayBufferToBase64(exported);
}

/**
 * Import peer's public key from base64
 */
export async function importPublicKey(base64PublicKey) {
  const buffer = base64ToArrayBuffer(base64PublicKey);
  return await window.crypto.subtle.importKey(
    "spki",
    buffer,
    {
      name: "ECDH",
      namedCurve: EC_CURVE,
    },
    true, // extractable
    []
  );
}

/**
 * Derive shared AES key from our private key + peer's public key
 */
export async function deriveSharedKey(privateKey, peerPublicKey) {
  return await window.crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: peerPublicKey,
    },
    privateKey,
    {
      name: AES_ALGORITHM,
      length: AES_LENGTH,
    },
    false, // not extractable
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a message using AES-256-GCM
 * Returns: { ciphertext: base64, iv: base64 }
 */
export async function encryptMessage(sharedKey, plaintext) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  
  // Generate random IV
  const iv = window.crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  
  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: AES_ALGORITHM,
      iv: iv,
      tagLength: AES_TAG_LENGTH,
    },
    sharedKey,
    data
  );
  
  return {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv),
  };
}

/**
 * Decrypt a message using AES-256-GCM
 */
export async function decryptMessage(sharedKey, ciphertext, iv) {
  try {
    const encryptedBuffer = base64ToArrayBuffer(ciphertext);
    const ivBuffer = base64ToArrayBuffer(iv);
    
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: AES_ALGORITHM,
        iv: ivBuffer,
        tagLength: AES_TAG_LENGTH,
      },
      sharedKey,
      encryptedBuffer
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error("[E2EE] Decryption failed:", error.message);
    throw new Error("Failed to decrypt message - possible tampering or wrong key");
  }
}

/**
 * Encrypt media (ArrayBuffer) using AES-256-GCM
 */
export async function encryptMedia(sharedKey, arrayBuffer) {
  const iv = window.crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  
  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: AES_ALGORITHM,
      iv: iv,
      tagLength: AES_TAG_LENGTH,
    },
    sharedKey,
    arrayBuffer
  );
  
  return {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv),
  };
}

/**
 * Decrypt media (returns ArrayBuffer)
 */
export async function decryptMedia(sharedKey, ciphertext, iv) {
  const encryptedBuffer = base64ToArrayBuffer(ciphertext);
  const ivBuffer = base64ToArrayBuffer(iv);
  
  return await window.crypto.subtle.decrypt(
    {
      name: AES_ALGORITHM,
      iv: ivBuffer,
      tagLength: AES_TAG_LENGTH,
    },
    sharedKey,
    encryptedBuffer
  );
}

// ============================================================================
// Key Storage (Session Only - Memory Only for Security)
// ============================================================================

const keyStore = new Map(); // guestId -> { keyPair, sharedKey, peerPublicKeyBase64 }

/**
 * Initialize E2EE for a chat session
 * Call this when chat starts
 */
export async function initializeE2EE(guestId) {
  const keyPair = await generateKeyPair();
  keyStore.set(guestId, {
    keyPair,
    sharedKey: null,
    peerPublicKeyBase64: null,
    established: false,
  });
  
  // Export and return our public key for exchange
  const publicKeyBase64 = await exportPublicKey(keyPair.publicKey);
  return { guestId, publicKey: publicKeyBase64 };
}

/**
 * Complete key exchange when we receive peer's public key
 */
export async function completeKeyExchange(guestId, peerPublicKeyBase64) {
  const store = keyStore.get(guestId);
  if (!store) {
    throw new Error("E2EE not initialized for this guest");
  }
  
  // Import peer's public key
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  
  // Derive shared key
  const sharedKey = await deriveSharedKey(store.keyPair.privateKey, peerPublicKey);
  
  // Update store
  store.sharedKey = sharedKey;
  store.peerPublicKeyBase64 = peerPublicKeyBase64;
  store.established = true;
  
  console.log(`[E2EE] Key exchange completed for ${guestId}`);
  return true;
}

/**
 * Establish a session from a server-managed conversation key (base64 raw AES-256).
 * Replaces the ephemeral ECDH handshake: both guest and branch fetch the SAME
 * key from the backend and import it as the AES-GCM shared key, so the channel
 * is "established" immediately and works even when the peer is offline. The
 * existing e2eeEncrypt/e2eeDecrypt paths use store.sharedKey unchanged.
 */
export async function establishWithServerKey(guestId, base64Key) {
  const raw = base64ToArrayBuffer(base64Key);
  const sharedKey = await window.crypto.subtle.importKey(
    "raw",
    raw,
    { name: AES_ALGORITHM },
    false, // not extractable
    ["encrypt", "decrypt"]
  );
  keyStore.set(guestId, {
    keyPair: null,
    sharedKey,
    peerPublicKeyBase64: null,
    established: true,
  });
  return true;
}

/**
 * Get encryption status for a session
 */
export function isE2EEEstablished(guestId) {
  const store = keyStore.get(guestId);
  return store?.established || false;
}

/**
 * Get our public key for exchange
 */
export async function getMyPublicKey(guestId) {
  const store = keyStore.get(guestId);
  if (!store) return null;
  return await exportPublicKey(store.keyPair.publicKey);
}

/**
 * Encrypt message for sending
 */
export async function e2eeEncrypt(guestId, plaintext) {
  const store = keyStore.get(guestId);
  if (!store || !store.established) {
    throw new Error("E2EE not established - cannot encrypt");
  }
  return await encryptMessage(store.sharedKey, plaintext);
}

/**
 * Decrypt received message
 */
export async function e2eeDecrypt(guestId, ciphertext, iv) {
  const store = keyStore.get(guestId);
  if (!store || !store.established) {
    throw new Error("E2EE not established - cannot decrypt");
  }
  return await decryptMessage(store.sharedKey, ciphertext, iv);
}

/**
 * Clear E2EE keys for a session (on logout/close)
 */
export function clearE2EE(guestId) {
  keyStore.delete(guestId);
  console.log(`[E2EE] Keys cleared for ${guestId}`);
}

/**
 * Clear all E2EE keys
 */
export function clearAllE2EE() {
  keyStore.clear();
  console.log("[E2EE] All keys cleared");
}

// ============================================================================
// Utility Functions
// ============================================================================

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
