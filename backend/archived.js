const { db } = require('./utils/firebase'); // Your Firebase config
const admin = require('firebase-admin'); // Ensure Admin SDK is available

const updateMessagesCollection = async () => {
  try {
    console.log('[MIGRATION] 🚀 Starting to backfill archived field...');

    const messagesRef = db.collection('messages');
    const snapshot = await messagesRef.get();

    const batch = db.batch();
    let counter = 0;

    snapshot.forEach((doc) => {
      const messageData = doc.data();

      // Only add 'archived: false' if it's missing
      if (messageData.archived === undefined) {
        batch.update(doc.ref, { archived: false });
        counter++;
      }
    });

    if (counter > 0) {
      await batch.commit();
      console.log(`[MIGRATION] ✅ Archived field added to ${counter} messages.`);
    } else {
      console.log('[MIGRATION] ✅ No missing archived fields. Nothing to update.');
    }
  } catch (error) {
    console.error('[MIGRATION] ❌ Error during archived field update:', error.message);
  }
};

// Run the script
updateMessagesCollection();
