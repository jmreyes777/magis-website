/**
 * updateAuctionCalendar.js
 * Updates the upcoming auction dates in
 * Firestore → siteConfig / auction
 */

const admin = require("firebase-admin");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "./backend.env") });

// -----------------------------
// Initialize Firebase Admin SDK
// -----------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();

/**
 * Add or replace the list of upcoming auctions.
 * Uses merge:true so existing doc fields (enabled, nextAuctionAt, notes)
 * remain untouched.
 *
 * @param {Array<{startAt: Date, endAt?: Date|null, label?: string}>} dates
 */
async function addUpcomingAuctions(dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    throw new Error("dates must be a non-empty array");
  }

  const auctionRef = db.collection("siteConfig").doc("auction");

  const upcoming = dates.map((d) => ({
    startAt: admin.firestore.Timestamp.fromDate(d.startAt),
    endAt: d.endAt ? admin.firestore.Timestamp.fromDate(d.endAt) : null,
    label: d.label || "",
  }));

  await auctionRef.set(
    {
      upcomingDates: upcoming,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log("🔥 Upcoming auction dates updated.");
}

/**
 * Example usage:
 * Run this script directly: `node updateAuctionCalendar.js`
 * Or call addUpcomingAuctions() from your admin API route.
 */
async function seedNextAuctions() {
  await addUpcomingAuctions([
    {
      startAt: new Date("2025-11-14T09:00:00+08:00"),
      label: "November Auction",
    },
    {
      startAt: new Date("2025-12-12T09:00:00+08:00"),
      label: "December Auction",
    },
  ]);

  console.log("✔ Seeded sample auction dates.");
}

// If run directly as a script: node updateAuctionCalendar.js
if (require.main === module) {
  seedNextAuctions()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { addUpcomingAuctions };
