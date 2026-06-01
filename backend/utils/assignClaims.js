//magis-project/backend/utils/assignClaims.js

const { admin } = require('./firebase'); // Import Firebase utilities from your existing firebase.js

async function assignCustomClaims(uid, branchId) {
  try {
    console.log(`[INFO] Assigning custom claims to UID: ${uid}`);
    const claims = { role: "branchadmin", branchId };
    await admin.auth().setCustomUserClaims(uid, claims);
    console.log("[SUCCESS] Custom claims assigned successfully:", claims);
  } catch (error) {
    console.error("[ERROR] Failed to assign custom claims:", error.message);
  }
}

// Replace with actual UID and branchId
const uid = "sTv3q5yFT2WxnKb7rKzIBiDXY5j1"; // Replace this with the user’s UID
const branchId = "671da3036f823d5152c633d3"; // Replace this with the branchId

// Uncomment the operation you want to perform
// checkCustomClaims(uid);
assignCustomClaims(uid, branchId);