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

/**
 * Function to assign custom claims to a user.
 * @param {string} uid - The Firebase UID of the user.
 * @param {object} claims - Custom claims object.
 */
const assignCustomClaims = async (uid, claims) => {
  try {
    console.log(`Assigning custom claims to user ${uid}:`, claims);
    await admin.auth().setCustomUserClaims(uid, claims);
    console.log(`Successfully assigned custom claims to user ${uid}.`);
  } catch (error) {
    console.error(`Failed to assign custom claims to user ${uid}:`, error.message);
  }
};

/**
 * Hardcoded Super Admin Users
 */
const hardcodedSuperAdmins = [
  {
    uid: 'fD856l9mNkOR5S3OKxeCPmFXk6n2', // Replace with the actual Firebase Auth UID
    email: 'jmreyes3167@gmail.com',     // Email for logging reference
    claims: { role: 'superadmin' },
  },
];

/**
 * Assign claims to hardcoded users
 */
const assignHardcodedSuperAdminClaims = async () => {
  try {
    console.log("Starting to assign super admin claims to hardcoded users...");

    for (const user of hardcodedSuperAdmins) {
      console.log(`Processing super admin: ${user.email} (UID: ${user.uid})`);
      await assignCustomClaims(user.uid, user.claims);
      console.log(`Super admin role assigned to user: ${user.email}`);
    }

    console.log("Super admin claims assignment completed.");
  } catch (error) {
    console.error("Error assigning super admin claims:", error.message);
  }
};

// Run the script
assignHardcodedSuperAdminClaims()
  .then(() => {
    console.log("Script execution finished.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error running the script:", error.message);
    process.exit(1);
  });