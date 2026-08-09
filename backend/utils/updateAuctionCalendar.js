// backend/utils/updateAuctionCalendar.js
const { db } = require("./firebase"); // v14: namespace API removed — shared lazy handle
const { Timestamp, FieldValue } = require("firebase-admin/firestore");

async function addUpcomingAuctions(dates) {
  // dates: array of { startAt: Date, endAt?: Date | null, label?: string }
  const auctionRef = db.collection("siteConfig").doc("auction");

  const upcoming = dates.map((d) => ({
    startAt: Timestamp.fromDate(d.startAt),
    endAt: d.endAt ? Timestamp.fromDate(d.endAt) : null,
    label: d.label || "",
  }));

  await auctionRef.set(
    {
      upcomingDates: upcoming,
      // keep existing fields; we DO NOT overwrite them by using merge:true
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// example usage:
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

  console.log("Upcoming auction dates saved.");
}

// call seedNextAuctions() from a script or route
