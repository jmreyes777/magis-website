/**
 * scripts/migrate-media-private.js  (P1-3, Option 2)
 * ---------------------------------------------------------------------------
 * One-time migration: convert EXISTING chat media from public objects + stored
 * public URLs to PRIVATE objects + a stored storage `path`. After this runs,
 * the frontends resolve media via short-lived signed URLs (resolver endpoints),
 * and no public chat object URLs remain in Firestore.
 *
 * For each `messages` doc whose `media` still holds a full http(s) URL:
 *   1) derive the storage path(s) from the URL (and srcSet, if present)
 *   2) revoke public read on the object(s)  -> file.makePrivate()
 *   3) overwrite media with { type, path[, paths][, name] } (drops url/src/srcSet)
 *
 * Idempotent: docs already on `path` (or with no media / no http url) are skipped.
 *
 * USAGE (run where prod FIREBASE_* env is available, e.g. Render shell):
 *   node scripts/migrate-media-private.js            # DRY RUN (no writes)
 *   node scripts/migrate-media-private.js --apply    # perform the migration
 *
 * Safe to re-run. Objects/docs already migrated are left untouched.
 * ---------------------------------------------------------------------------
 */

try { require("dotenv").config({ path: require("path").join(__dirname, "..", "backend.env") }); } catch (_) {}
try { require("dotenv").config(); } catch (_) {}

const { db, storage } = require("../utils/firebase");

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 300;
const bucket = storage.bucket();
const BUCKET = bucket.name;

const isHttp = (s) => typeof s === "string" && /^https?:\/\//i.test(s);

// Extract the object path from a stored public URL of the form
// https://storage.googleapis.com/<bucket>/<path>
function pathFromUrl(url) {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname); // "/<bucket>/<path>"
    const prefix = `/${BUCKET}/`;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    // Fallback: some SDKs use /<bucket>/o/<path>; handle the simple cases only.
    const parts = p.replace(/^\//, "").split("/");
    if (parts[0] === BUCKET) return parts.slice(1).join("/");
    return null;
  } catch (_) {
    return null;
  }
}

// Parse "<url> 320w, <url> 640w" -> [{ width, path }]
function pathsFromSrcSet(srcSet) {
  if (typeof srcSet !== "string" || !srcSet.trim()) return null;
  const out = [];
  for (const entry of srcSet.split(",")) {
    const t = entry.trim();
    if (!t) continue;
    const sp = t.split(/\s+/);
    const url = sp[0];
    const width = parseInt((sp[1] || "").replace(/w$/i, ""), 10);
    const path = pathFromUrl(url);
    if (path && Number.isFinite(width)) out.push({ width, path });
  }
  return out.length ? out : null;
}

async function makePrivateSafe(path) {
  try {
    await bucket.file(path).makePrivate({ strict: false });
    return true;
  } catch (e) {
    console.warn(`   ⚠️ makePrivate failed for ${path}: ${e.message}`);
    return false;
  }
}

async function run() {
  console.log(`[migrate-media] bucket=${BUCKET} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  let last = null;
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  // Paginate by document name to avoid loading the whole collection at once.
  // (Avoids needing an index; __name__ ordering is always available.)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = db.collection("messages").orderBy("__name__").limit(PAGE_SIZE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1].id;

    for (const doc of snap.docs) {
      scanned++;
      const m = doc.data().media;
      if (!m || typeof m !== "object") { skipped++; continue; }
      if (m.path) { skipped++; continue; }          // already migrated
      const url = isHttp(m.url) ? m.url : (isHttp(m.src) ? m.src : null);
      if (!url) { skipped++; continue; }             // nothing public to migrate

      const paths = pathsFromSrcSet(m.srcSet);
      const path = pathFromUrl(url) || (paths && paths[paths.length - 1] && paths[paths.length - 1].path);
      if (!path) {
        console.warn(`   ⚠️ ${doc.id}: could not derive path from url; skipping`);
        skipped++;
        continue;
      }

      const newMedia = { type: m.type || "file", path };
      if (paths) newMedia.paths = paths;
      if (m.name) newMedia.name = m.name;

      console.log(`   • ${doc.id}: ${m.type || "?"} -> path=${path}${paths ? ` (+${paths.length} sizes)` : ""}`);

      if (APPLY) {
        try {
          const all = new Set([path, ...(paths ? paths.map((p) => p.path) : [])]);
          for (const p of all) await makePrivateSafe(p);
          await doc.ref.update({ media: newMedia });
          migrated++;
        } catch (e) {
          console.error(`   ❌ ${doc.id}: update failed: ${e.message}`);
          errors++;
        }
      } else {
        migrated++; // would-migrate count in dry-run
      }
    }
  }

  console.log(
    `[migrate-media] done. scanned=${scanned} ${APPLY ? "migrated" : "would-migrate"}=${migrated} skipped=${skipped} errors=${errors}`
  );
  if (!APPLY) console.log("[migrate-media] DRY RUN only — re-run with --apply to perform changes.");
  process.exit(errors ? 1 : 0);
}

run().catch((e) => {
  console.error("[migrate-media] fatal:", e);
  process.exit(1);
});
