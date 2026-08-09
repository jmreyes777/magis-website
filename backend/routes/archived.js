// v14: namespace API removed — modular init (this is a standalone one-off
// backfill script, not a mounted route; it uses ADC credentials).
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");
initializeApp();

const db = getFirestore();

async function backfillArchivedField() {
  const PAGE_SIZE = Number(process.env.BACKFILL_PAGE_SIZE || 500);
  const messagesRef = db.collection("messages");

  let lastDoc = null;
  let scanned = 0;
  let processed = 0;
  let page = 0;

  console.log("[MIGRATION] 🔍 Scanning messages collection (paginated)...");

  // PERF2-2: cursor-paginate by document id instead of loading the ENTIRE
  // collection into memory with a single .get() (cost/memory grew unbounded
  // and would OOM/fail on a large collection). Memory now stays bounded to one
  // page. Idempotent: only stamps docs missing the `archived` field; ordering
  // by documentId needs no composite index, and each page commits <= PAGE_SIZE
  // updates (within Firestore's 500-op batch limit).
  for (;;) {
    let query = messagesRef
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    let batch = db.batch();
    let batchCount = 0;
    for (const doc of snapshot.docs) {
      scanned++;
      if (doc.data().archived === undefined) {
        batch.update(doc.ref, { archived: false });
        batchCount++;
        processed++;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
      console.log(`[MIGRATION] ✅ Page ${++page}: committed ${batchCount} update(s) (scanned ${scanned} so far).`);
    } else {
      console.log(`[MIGRATION] Page ${++page}: no updates needed (scanned ${scanned} so far).`);
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break; // reached the final (partial) page
  }

  console.log(`[MIGRATION] 🎉 Backfilled 'archived: false' on ${processed} of ${scanned} scanned message(s).`);
}

backfillArchivedField().catch((err) => {
  console.error("[MIGRATION] ❌ Error during backfill:", err.message, err);
});
