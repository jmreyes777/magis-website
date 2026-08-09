#!/usr/bin/env node
/**
 * regen-conv-keys.js — find (and optionally regenerate) conversation keys that can
 * no longer be decrypted by the configured CONV_KEY_SECRET (+ CONV_KEY_SECRET_FALLBACKS).
 *
 * Such keys were wrapped under an OLDER secret that is no longer available, so their
 * existing message history is ALREADY unreadable. Deleting the doc lets the backend
 * recreate a fresh key (under the current CONV_KEY_SECRET) the next time that
 * conversation is opened — restoring forward functionality. New messages work; the
 * (already-lost) old history is not recovered. Decryptable keys are left untouched.
 *
 * SAFE BY DEFAULT: dry-run — lists affected docs, deletes NOTHING. Pass --delete to
 * actually remove the un-decryptable docs.
 *
 * Reads FIREBASE_* + CONV_KEY_SECRET[+CONV_KEY_SECRET_FALLBACKS] from backend/backend.env.
 * Initializes firebase-admin DIRECTLY (does NOT import utils/firebase.js, which has
 * import-time side effects like enableTotpMfa()).
 *
 * Usage (from repo root):
 *   node backend/scripts/regen-conv-keys.js            # dry-run (report only)
 *   node backend/scripts/regen-conv-keys.js --delete   # delete un-decryptable docs
 */
const path = require("path");
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app"); // v14: namespace API removed
const { getFirestore } = require("firebase-admin/firestore");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", "backend.env") });

const DELETE = process.argv.includes("--delete");

// --- secret candidates (mirror routes/messages.js deriveUnwrapKeys) ---
const secrets = [
  process.env.CONV_KEY_SECRET || "",
  ...(process.env.CONV_KEY_SECRET_FALLBACKS || "").split(/[,\n]/),
]
  .map((s) => s.trim())
  .filter(Boolean);

if (!secrets.length) {
  console.error(
    "[regen] No CONV_KEY_SECRET in backend/backend.env. Add CONV_KEY_SECRET=<your Render value> " +
      "(the fp=eaa3b941 secret) so this script can tell which keys are still decryptable, then re-run."
  );
  process.exit(1);
}

const fp = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
const masters = secrets.map((s) => ({
  fp: fp(s),
  key: crypto.createHash("sha256").update(s).digest(),
}));
console.log(`[regen] configured secret fingerprints: ${masters.map((m) => m.fp).join(", ")}`);

// True if the stored key is plaintext (raw) OR decrypts under ANY configured secret.
function canDecrypt(stored) {
  if (!stored || !String(stored).startsWith("v1:")) return true; // raw/plaintext — readable as-is
  const [, ivB64, tagB64, encB64] = String(stored).split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  for (const { key } of masters) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      Buffer.concat([d.update(enc), d.final()]);
      return true;
    } catch {
      /* try the next secret */
    }
  }
  return false;
}

for (const v of ["FIREBASE_PROJECT_ID", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL"]) {
  if (!process.env[v]) {
    console.error(`[regen] Missing ${v} in backend/backend.env`);
    process.exit(1);
  }
}
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
});
const db = getFirestore();

(async () => {
  console.log(
    `[regen] project=${process.env.FIREBASE_PROJECT_ID}  mode=${DELETE ? "DELETE" : "DRY-RUN"}`
  );
  const snap = await db.collection("conversationKeys").get();
  const affected = [];
  let okCount = 0;
  snap.forEach((doc) => {
    if (canDecrypt(doc.data().key)) okCount += 1;
    else affected.push(doc.id);
  });

  console.log(
    `[regen] total=${snap.size}  decryptable=${okCount}  un-decryptable=${affected.length}`
  );
  if (affected.length) {
    console.log("[regen] un-decryptable doc ids:");
    affected.forEach((id) => console.log("   - " + id));
  }

  if (!affected.length) {
    console.log("[regen] nothing to do — every key decrypts with the configured secret(s).");
    process.exit(0);
  }
  if (!DELETE) {
    console.log(
      "\n[regen] DRY-RUN only — nothing was deleted. Re-run with --delete to remove the above " +
        "docs so they regenerate (under fp=" + masters[0].fp + ") on next open."
    );
    process.exit(0);
  }

  const ids = affected.slice();
  while (ids.length) {
    const batch = db.batch();
    ids.splice(0, 400).forEach((id) => batch.delete(db.collection("conversationKeys").doc(id)));
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
  console.log(
    `[regen] deleted ${affected.length} un-decryptable key doc(s). They will be recreated under ` +
      `fp=${masters[0].fp} the next time each conversation is opened.`
  );
  process.exit(0);
})().catch((e) => {
  console.error("[regen] FAILED:", e && e.message ? e.message : e);
  process.exit(1);
});
