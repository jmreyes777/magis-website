require("dotenv").config({ path: "./backend.env" });
const { initializeApp, cert } = require("firebase-admin/app"); // v14: namespace API removed
const { getFirestore } = require("firebase-admin/firestore");

// Initialize Firebase
const firebaseApp = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = getFirestore();

async function testMessagesCollection() {
  try {
    console.log("[TEST] Connecting to Firestore...");
    const snapshot = await db.collection("messages").limit(10).get();
    console.log(`[TEST] Total messages in collection: ${snapshot.size}`);
    
    if (snapshot.size > 0) {
      const sampleMessages = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      console.log("[TEST] Sample messages:", JSON.stringify(sampleMessages, null, 2));
    } else {
      console.log("[TEST] No messages found in collection");
    }
  } catch (error) {
    console.error("[TEST] Error:", error.message);
  }
}

testMessagesCollection().then(() => process.exit(0));
