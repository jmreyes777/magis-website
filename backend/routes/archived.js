const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

async function backfillArchivedField() {
  const BATCH_SIZE = 500;
  let processed = 0;

  console.log("[MIGRATION] 🔍 Scanning messages collection...");

  const snapshot = await db.collection("messages").get();
  const total = snapshot.size;
  console.log(`[MIGRATION] 🧾 Found ${total} message(s) to check.`);

  let batch = db.batch();
  let batchCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.archived === undefined) {
      batch.update(doc.ref, { archived: false });
      processed++;
      batchCount++;
    }

    // Commit every BATCH_SIZE operations
    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      console.log(`[MIGRATION] ✅ Committed batch of ${batchCount}.`);
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    console.log(`[MIGRATION] ✅ Final batch of ${batchCount} committed.`);
  }

  console.log(`[MIGRATION] 🎉 Backfilled 'archived: false' on ${processed} message(s).`);
}

backfillArchivedField().catch((err) => {
  console.error("[MIGRATION] ❌ Error during backfill:", err.message, err);
});
