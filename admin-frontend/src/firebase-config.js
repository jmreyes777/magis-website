// Import the necessary functions from the Firebase SDKs
import { initializeApp } from "firebase/app";
import { 
  getAuth, 
  setPersistence, 
  browserSessionPersistence 
} from "firebase/auth";
import { initializeFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Firebase app's configuration object
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
console.log("[INFO] Firebase initialized successfully");

// Initialize services
// Auto-detect long-polling so Firestore gracefully falls back when the
// streaming WebChannel is blocked (proxies, VPNs, some networks/extensions),
// eliminating the noisy 'Listen' 400/404 transport-errored reconnect churn.
const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
});
const auth = getAuth(app);
const storage = getStorage(app);

// Set authentication persistence to browser session
setPersistence(auth, browserSessionPersistence)
  .then(() => {
    console.log("[INFO] Authentication persistence set to browser session.");
  })
  .catch((error) => {
    console.error("[ERROR] Error setting authentication persistence:", error.message);
  });

/**
 * Utility function to fetch and validate custom claims for the authenticated user.
 * @param {object} user - The authenticated user object from Firebase Auth.
 * @returns {object|null} - Returns the validated claims or null if validation fails.
 */
const fetchCustomClaims = async (user) => {
  if (!user) {
    console.warn("[WARNING] No user provided. Cannot fetch custom claims.");
    return null;
  }

  try {
    const tokenResult = await user.getIdTokenResult();
    console.log("[INFO] Custom claims fetched successfully:", tokenResult.claims);

    const claims = tokenResult.claims;

    // Validate claims
    validateClaims(claims);

    return claims; // Return validated claims
  } catch (error) {
    console.error("[ERROR] Error fetching custom claims:", error.message);
    return null;
  }
};

/**
 * Validate the structure and content of custom claims.
 * @param {object} claims - Custom claims fetched from Firebase.
 * @throws Will throw an error if the claims are invalid.
 */
const validateClaims = (claims) => {
  if (!claims.role) {
    throw new Error("[ERROR] Invalid claims: Missing role information.");
  }

  if (claims.role === "branchadmin" && (!claims.branchId || !claims.branchName)) {
    throw new Error("[ERROR] Invalid claims: Missing branch-specific information.");
  }

  console.log(`[INFO] Claims validated for role: ${claims.role}`);
};

// Export Firebase app and services
export { app, db, auth, storage, fetchCustomClaims };