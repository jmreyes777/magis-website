// backend/scripts/purge-branchadmin-passwords.js
// ---------------------------------------------------------------------------
// HYG-4 (OWASP-2025-COMPLIANCE.md): purge stale `password` (bcrypt) hashes from
// the `branchAdmins` collection.
//
// Branch-admin authentication migrated to Firebase + JWT. NO surviving backend
// code reads `adminData.password` or uses bcrypt — the only consumer was the
// now-deleted `routes/branchadminauth.js` (which `require("bcrypt")`, a package
// that isn't even installed). Any `password` field still stored on a
// `branchAdmins` doc is therefore dead credential material and should go.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
//   * DRY-RUN BY DEFAULT: only REPORTS which docs carry a stale field; writes
//     NOTHING. Pass --apply to actually delete the field(s).
//   * It removes ONLY the listed field(s) via FieldValue.delete(); every other
//     field on the doc (email, branchId, role, MFA enrollment, ...) is kept.
//   * Run with the SAME Firebase service-account creds as the backend (it loads
//     backend/backend.env via utils/firebase). NEVER commit those creds.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   node backend/scripts/purge-branchadmin-passwords.js            # dry-run (default)
//   node backend/scripts/purge-branchadmin-passwords.js --apply    # actually purge
//
// Review the dry-run output first, then re-run with --apply.
// ---------------------------------------------------------------------------

const { admin, db } = require("../utils/firebase");

const COLLECTION = "branchAdmins";
// Stale credential field(s) left over from the retired password-login flow.
// `password` is the bcrypt hash flagged by HYG-4. (The lockout artifacts
// `failedAttempts`/`lockedUntil` are non-sensitive and intentionally left alone.)
const STALE_FIELDS = ["password"];

const APPLY = process.argv.includes("--apply");
const BATCH_LIMIT = 400; // Firestore caps a batch at 500; stay safely under.

async function main() {
  console.log(
    `[purge] collection="${COLLECTION}" fields=[${STALE_FIELDS.join(", ")}] ` +
      `mode=${APPLY ? "APPLY (will delete)" : "DRY-RUN (no writes)"}`
  );

  const snap = await db.collection(COLLECTION).get();
  if (snap.empty) {
    console.log(`[purge] '${COLLECTION}' is empty or does not exist — nothing to do.`);
    return;
  }

  const matches = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const present = STALE_FIELDS.filter((f) =>
      Object.prototype.hasOwnProperty.call(data, f)
    );
    if (present.length) matches.push({ id: doc.id, ref: doc.ref, fields: present });
  });

  console.log(
    `[purge] scanned ${snap.size} doc(s); ${matches.length} carry a stale field:`
  );
  matches.forEach((m) => console.log(`  - ${m.id}: ${m.fields.join(", ")}`));

  if (!matches.length) {
    console.log("[purge] nothing to purge.");
    return;
  }

  if (!APPLY) {
    console.log(
      "\n[purge] DRY-RUN complete — no writes made. " +
        "Re-run with --apply to delete the field(s) listed above."
    );
    return;
  }

  const deletion = {};
  STALE_FIELDS.forEach((f) => {
    deletion[f] = admin.firestore.FieldValue.delete();
  });

  let updated = 0;
  for (let i = 0; i < matches.length; i += BATCH_LIMIT) {
    const slice = matches.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    slice.forEach((m) => batch.update(m.ref, deletion));
    await batch.commit();
    updated += slice.length;
    console.log(`[purge] committed ${updated}/${matches.length}`);
  }

  console.log(
    `\n[purge] DONE — removed [${STALE_FIELDS.join(", ")}] from ${updated} doc(s).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[purge] FAILED:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
