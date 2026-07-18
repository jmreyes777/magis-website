//magis-project/backend/utils/firebase.js

const admin = require("firebase-admin");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../backend.env") });

// TST5 (testing megaplan): initialization is LAZY. Importing this module has
// no side effects — no env validation, no credential use, no network probes —
// so route/middleware modules (which destructure { db } at import) can be
// loaded in tests without credentials. Production behavior is unchanged:
// server.js calls initFirebase() eagerly at boot, which validates env
// (fail-fast exit, as before), initializes the SDK, and runs the same
// connectivity probes + TOTP project config as the old import-time code.
const REQUIRED_ENV_VARS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_STORAGE_BUCKET",
];

const _real = { db: null, storage: null, app: null };
let _initialized = false;

function initFirebase() {
  if (_initialized) return _real;

  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length) {
    missing.forEach((v) => console.error(`[ERROR] Missing environment variable: ${v}`));
    if (process.env.NODE_ENV === "test") {
      // Tests must never be killed by a hard exit — surface a catchable error
      // (a route touching Firestore in a test will 500 through the normal
      // error handler instead of nuking the runner).
      throw new Error(`Firebase env missing: ${missing.join(", ")}`);
    }
    process.exit(1);
  }
  console.log("[INFO] All required environment variables are loaded.");

  try {
    if (!admin.apps.length) {
      _real.app = admin.initializeApp({
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
      _real.app = admin.app();
      console.log("[INFO] Firebase already initialized.");
    }

    _real.db = admin.firestore();
    _real.db.settings({ ignoreUndefinedProperties: true });
    _real.storage = admin.storage();
    console.log("[SUCCESS] Firestore and Storage initialized.");
  } catch (error) {
    console.error("[CRITICAL] Failed to initialize Firebase:", error.message);
    if (process.env.NODE_ENV === "test") throw error;
    process.exit(1);
  }

  _initialized = true;
  runStartupChecks(); // fire-and-forget, same as the old import-time behavior
  return _real;
}

// Lazy proxies: consumers everywhere do `const { db } = require("./firebase")`
// at import time; the proxy defers SDK initialization until the first actual
// use (e.g. db.collection(...)), then delegates every access to the real object.
function lazyHandle(pick) {
  return new Proxy({}, {
    get(_target, prop) {
      const real = pick(initFirebase());
      const value = real[prop];
      return typeof value === "function" ? value.bind(real) : value;
    },
    has(_target, prop) {
      return prop in pick(initFirebase());
    },
  });
}

const db = lazyHandle((r) => r.db);
const storage = lazyHandle((r) => r.storage);

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

const { getAuth } = require("firebase-admin/auth");

// Boot-time connectivity probes + TOTP MFA project config. Runs once, from
// initFirebase() — identical work to the old import-time IIFEs, just deferred
// until initialization actually happens.
function runStartupChecks() {
  (async () => {
    try {
      await _real.db.collection("test").limit(1).get();
      console.log("[SUCCESS] Connected to Firestore.");
    } catch (error) {
      console.error("[ERROR] Firestore connection test failed:", error.message);
    }
  })();

  (async () => {
    try {
      await _real.storage.bucket().getFiles({ maxResults: 1 });
      console.log("[SUCCESS] Connected to Firebase Storage.");
    } catch (error) {
      console.error("[ERROR] Storage connection test failed:", error.message);
    }
  })();

  enableTotpMfa();
}

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

// ✅ Export Functions and Instances
// (firebaseApp was exported before but had zero consumers; initFirebase is the
// explicit boot hook used by server.js.)
module.exports = {
  admin,
  db,
  storage,
  initFirebase,
  uploadToStorage,
  assignCustomClaims,
  getCustomClaims,
};
