//magis-project/backend/utils/firebase.js

const admin = require("firebase-admin");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../backend.env") });

// ✅ Validate required environment variables
const validateEnvVars = () => {
  const requiredEnvVars = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_STORAGE_BUCKET",
  ];

  requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
      console.error(`[ERROR] Missing environment variable: ${varName}`);
      process.exit(1);
    }
  });
  console.log("[INFO] All required environment variables are loaded.");
};
validateEnvVars();

// ✅ Initialize Firebase Admin SDK
let firebaseApp;
try {
  if (!admin.apps.length) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
      databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    console.log("[SUCCESS] Firebase successfully initialized.");
  } else {
    firebaseApp = admin.app();
    console.log("[INFO] Firebase already initialized.");
  }
} catch (error) {
  console.error("[CRITICAL] Failed to initialize Firebase:", error.message);
  process.exit(1);
}

// ✅ Initialize Firestore and Storage
let db, storage;
try {
  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  storage = admin.storage();
  console.log("[SUCCESS] Firestore and Storage initialized.");
} catch (error) {
  console.error("[ERROR] Failed to initialize Firestore or Storage:", error.message);
  process.exit(1);
}

// ✅ Utility Functions for Custom Claims
const validateClaims = (claims) => {
  if (!claims || typeof claims !== "object") {
    throw new Error("Invalid claims object.");
  }

  if (claims.role === "superadmin") return; // Super admins don't need branch-specific claims

  const requiredKeys = ["role", "branchId", "branchName"];
  requiredKeys.forEach((key) => {
    if (!claims[key]) {
      throw new Error(`Missing required claim: ${key}`);
    }
  });
};

const assignCustomClaims = async (uid, claims) => {
  if (!uid || typeof uid !== "string") {
    throw new Error("[ERROR] User ID (uid) must be a valid string.");
  }

  try {
    validateClaims(claims);
    await admin.auth().setCustomUserClaims(uid, claims);
    console.log(`[SUCCESS] Assigned claims to user ${uid}:`, claims);
  } catch (error) {
    console.error(`[ERROR] Failed to assign claims to user ${uid}:`, error.message);
    throw error;
  }
};

const getCustomClaims = async (uid) => {
  if (!uid || typeof uid !== "string") {
    throw new Error("[ERROR] User ID (uid) must be a valid string.");
  }

  try {
    const userRecord = await admin.auth().getUser(uid);
    console.log(`[INFO] Retrieved claims for user ${uid}:`, userRecord.customClaims);
    return userRecord.customClaims || {};
  } catch (error) {
    console.error(`[ERROR] Failed to retrieve claims for user ${uid}:`, error.message);
    throw error;
  }
};

// ✅ Utility Function to Upload Files to Firebase Storage
const uploadToStorage = async (fileBuffer, fileName, metadata = {}) => {
  if (!fileBuffer || !fileName) {
    throw new Error("[ERROR] fileBuffer and fileName are required for upload.");
  }

  try {
    const file = storage.bucket().file(fileName);
    const options = {
      metadata: {
        contentType: metadata.contentType || "application/octet-stream",
        metadata: {
          uploadedBy: metadata.uploadedBy || "unknown",
          timestamp: new Date().toISOString(),
        },
      },
    };

    await file.save(fileBuffer, options);
    await file.makePublic(); // Adjust if private access is required
    console.log(`[SUCCESS] File uploaded to Firebase Storage: ${fileName}`);
    return `https://storage.googleapis.com/${storage.bucket().name}/${fileName}`;
  } catch (error) {
    console.error("[ERROR] Failed to upload file to Firebase Storage:", error.message);
    throw error;
  }
};

// ✅ Test Firestore Connectivity
(async () => {
  try {
    if (!db) throw new Error("Firestore is not initialized.");
    await db.collection("test").limit(1).get();
    console.log("[SUCCESS] Connected to Firestore.");
  } catch (error) {
    console.error("[ERROR] Firestore connection test failed:", error.message);
  }
})();

// ✅ Test Storage Connectivity
(async () => {
  try {
    if (!storage) throw new Error("Storage is not initialized.");
    await storage.bucket().getFiles({ maxResults: 1 });
    console.log("[SUCCESS] Connected to Firebase Storage.");
  } catch (error) {
    console.error("[ERROR] Storage connection test failed:", error.message);
  }
})();

const { getAuth } = require("firebase-admin/auth");

// ✅ Enable TOTP Multi-Factor Authentication (MFA)
const enableTotpMfa = async () => {
  try {
    await getAuth().projectConfigManager().updateProjectConfig({
      multiFactorConfig: {
        state: "ENABLED", // ✅ Enable MFA globally
        providerConfigs: [
          {
            state: "ENABLED",
            totpProviderConfig: {
              adjacentIntervals: 5, // ✅ Accepts adjacent TOTP intervals (default: 5)
            },
          },
        ],
      },
    });

    console.log("✅ TOTP Multi-Factor Authentication enabled successfully.");
  } catch (error) {
    console.error("❌ Failed to enable TOTP MFA:", error.message);
  }
};

// ✅ Call this function after Firebase Admin SDK initialization
enableTotpMfa();

// ✅ Export Functions and Instances
module.exports = {
  admin,
  firebaseApp,
  db,
  storage,
  uploadToStorage,
  assignCustomClaims,
  getCustomClaims,
};
