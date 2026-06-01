const admin = require("firebase-admin");
const dotenv = require("dotenv");
const path = require("path");

// ✅ Load environment variables
dotenv.config({ path: path.resolve(__dirname, "./backend.env") });

// ✅ Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
  console.log("[SUCCESS] Firebase Admin SDK initialized.");
} else {
  console.log("[INFO] Firebase Admin SDK already initialized.");
}

// ✅ Function to Unenroll TOTP MFA
async function unenrollMfa(userId) {
  try {
    const user = await admin.auth().getUser(userId);

    if (!user.multiFactor || user.multiFactor.enrolledFactors.length === 0) {
      console.log("[INFO] No MFA factors to remove.");
      return;
    }

    // 🔹 Get the first enrolled factor's UID (for TOTP)
    const mfaFactorUid = user.multiFactor.enrolledFactors[0].uid;

    // 🔹 Unenroll the TOTP factor
    await admin.auth().updateUser(userId, {
      multiFactor: {
        enrolledFactors: user.multiFactor.enrolledFactors.filter((factor) => factor.uid !== mfaFactorUid),
      },
    });

    console.log(`[SUCCESS] Unenrolled TOTP MFA for user: ${user.email}`);
  } catch (error) {
    console.error("[ERROR] Failed to unenroll MFA:", error.message);
  }
}

// Replace with the Firebase UID of the user you want to unenroll
const userId = "sTv3q5yFT2WxnKb7rKzIBiDXY5j1"; // 🔹 Replace with your actual user UID
unenrollMfa(userId);
