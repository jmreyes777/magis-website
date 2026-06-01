const admin = require('firebase-admin');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, './backend.env') });

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const assignCustomClaims = async (uid, claims) => {
  try {
    console.log(`Assigning custom claims to user ${uid}:`, claims);
    await admin.auth().setCustomUserClaims(uid, claims);
    console.log(`Successfully assigned custom claims to user ${uid}.`);
  } catch (error) {
    console.error(`Failed to assign custom claims to user ${uid}:`, error.message);
  }
};

// Main script function
const reassignClaims = async () => {
  // Replace these details with the user's UID and claims
  const testUsers = [
    {
      uid: 'sTv3q5yFT2WxnKb7rKzIBiDXY5j1', // Example UID
      claims: {
        role: 'branchadmin',
        branchId: '671da3036f823d5152c633d3',
        branchName: 'Dolores',
      },
    },
  ];

  for (const user of testUsers) {
    await assignCustomClaims(user.uid, user.claims);
  }

  console.log('Custom claims reassignment completed.');
};

// Run the script
reassignClaims()
  .then(() => {
    console.log('Script execution finished.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error running the script:', error.message);
    process.exit(1);
  });
