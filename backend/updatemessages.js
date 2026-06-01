const { db } = require('./utils/firebase'); // Adjust the path to your Firebase config
const admin = require('firebase-admin'); // Ensure Admin SDK is available

const updateMessagesCollection = async () => {
  try {
    console.log('Starting to update messages collection...');

    // Reference the messages collection
    const messagesRef = db.collection('messages');
    const snapshot = await messagesRef.get();

    // Loop through each document in the collection
    const batch = db.batch(); // Use a batch for atomic updates
    snapshot.forEach((doc) => {
      const messageData = doc.data();

      // Add or update the new fields with default values (if missing)
      batch.update(doc.ref, {
        guestName: messageData.guestName || 'Unknown Guest', // Default guestName
        guestPhone: messageData.guestPhone || null,         // Default guestPhone
        guestEmail: messageData.guestEmail || null,         // Default guestEmail
      });
    });

    // Commit the batch
    await batch.commit();
    console.log('Messages collection updated successfully.');
  } catch (error) {
    console.error('Error updating messages collection:', error.message);
  }
};

// Run the script
updateMessagesCollection();
