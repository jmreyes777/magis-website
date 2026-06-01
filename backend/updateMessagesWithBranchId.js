// 🚀 Import Firebase Admin SDK securely
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

// ✅ Load environment variables securely
dotenv.config({ path: path.join(__dirname, "backend.env") });

let serviceAccount;

// 🔹 Step 1: Try loading from `.env`
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("[INFO] Using FIREBASE_SERVICE_ACCOUNT from environment variables.");
  } catch (error) {
    console.error("[ERROR] Invalid FIREBASE_SERVICE_ACCOUNT JSON:", error.message);
    process.exit(1);
  }
}

// 🔹 Step 2: Fallback to `serviceaccountkey.json` if `.env` is missing or invalid
if (!serviceAccount) {
  const keyPath = path.join(__dirname, "firebase.json");
  if (fs.existsSync(keyPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      console.log("[INFO] Using serviceaccountkey.json.");
    } catch (error) {
      console.error("[ERROR] Failed to parse serviceaccountkey.json:", error.message);
      process.exit(1);
    }
  } else {
    console.error("[ERROR] No Firebase credentials found in .env or serviceaccountkey.json.");
    process.exit(1);
  }
}

// ✅ Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function updateMessagesWithBranchId() {
  try {
    console.log("[INFO] Fetching branch data...");

    // 🔹 Step 1: Load all branches
    const branchesSnapshot = await db.collection("branches").get();
    const branchMap = {};

    branchesSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.email && data.branchId) {
        branchMap[data.email] = data.branchId; // 🔹 Map email to branchId
      }
    });

    console.log(`[INFO] Loaded ${Object.keys(branchMap).length} branches.`);

    // 🔹 Step 2: Fetch **all** messages (instead of filtering by null)
    console.log("[INFO] Fetching all messages...");
    const messagesSnapshot = await db.collection("messages").get();

    if (messagesSnapshot.empty) {
      console.log("[INFO] No messages found in the database.");
      return;
    }

    // 🔹 Step 3: Identify messages missing `branchId`
    const batch = db.batch();
    let updateCount = 0;

    messagesSnapshot.forEach((doc) => {
      const messageData = doc.data();
      const branchEmail = messageData.branchEmail;

      // 🔹 Only update if `branchId` is missing
      if (!messageData.branchId && branchEmail && branchMap[branchEmail]) {
        const messageRef = db.collection("messages").doc(doc.id);
        batch.update(messageRef, { branchId: branchMap[branchEmail] });
        updateCount++;
        console.log(`[UPDATE] Message ${doc.id} assigned branchId: ${branchMap[branchEmail]}`);
      }
    });

    // 🔹 Commit batch update
    if (updateCount > 0) {
      await batch.commit();
      console.log(`[SUCCESS] Updated ${updateCount} messages with branchId.`);
    } else {
      console.log("[INFO] No messages required updates.");
    }
  } catch (error) {
    console.error("[ERROR] Failed to update messages:", error.message);
  } finally {
    process.exit(0);
  }
}

// 🔹 Run the function
updateMessagesWithBranchId();
