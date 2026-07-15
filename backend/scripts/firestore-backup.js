// backend/scripts/firestore-backup.js
//
// BDR1+BDR4 (backup & DR megaplan): app-level Firestore snapshot + Storage
// mirror, using the same firebase-admin credential the backend runs on (no
// extra IAM, no gcloud, no console).
//
// What one run produces (in the project's own Storage bucket):
//   backups/firestore/YYYY-MM-DD/<collection>.jsonl.gz   one per top-level
//     collection; each line = {"path":"col/doc[/sub/doc…]","data":{…}} with
//     Firestore types tagged losslessly (see serializeValue).
//   backups/firestore/YYYY-MM-DD/manifest.json           per-collection doc
//     counts, gz bytes, sha256, duration, engine version. Restore verifies
//     against this.
//   backups/storage-objects/…                            incremental md5-keyed
//     mirror of every non-backup object in the bucket (12.6 MB total today).
//   Firestore doc backups/status                          last-run summary for
//     the admin Observability card (BDR2) and staleness alerting.
//
// Retention: keeps the newest 30 daily snapshots plus 8 Sunday snapshots,
// prunes the rest. Mirror objects are kept in sync (deleted sources are kept
// in the mirror — the mirror only grows; snapshots' object manifests say what
// existed when).
//
// Sensitivity: snapshots include conversationKeys → treat backup files as
// secrets (see megaplan BDR0 note).
//
// Usage:
//   node scripts/firestore-backup.js            run a full backup now
//   const { runBackup } = require(".../firestore-backup"); await runBackup();
//     (BDR2 route calls this in-process; it streams, so RSS stays flat.)

const zlib = require("zlib");
const crypto = require("crypto");
const path = require("path");
const { PassThrough } = require("stream");
const { pipeline } = require("stream/promises");

const ENGINE = "jsonl-v1";
const PAGE = 500; // docs per read page
const SUBPROBE_CONCURRENCY = 20; // parallel listCollections() probes
const KEEP_DAILY = Math.max(parseInt(process.env.BACKUP_KEEP_DAILY, 10) || 30, 1);
const KEEP_WEEKLY = Math.max(parseInt(process.env.BACKUP_KEEP_WEEKLY, 10) || 8, 0);
const FS_PREFIX = "backups/firestore/";
const MIRROR_PREFIX = "backups/storage-objects/";

// ── Firestore value serialization (lossless, restore-symmetric) ─────────────
function serializeValue(v) {
  if (v === null || v === undefined) return v === undefined ? undefined : null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (v instanceof Date) return { __t: "ts", ms: v.getTime() };
  // Firestore Timestamp (has toDate) — duck-typed to avoid importing the class.
  if (typeof v.toDate === "function" && typeof v.seconds === "number")
    return { __t: "ts", ms: v.toDate().getTime(), ns: v.nanoseconds % 1e6 || 0 };
  if (typeof v.latitude === "number" && typeof v.longitude === "number" && v.constructor && /GeoPoint/.test(v.constructor.name))
    return { __t: "geo", lat: v.latitude, lng: v.longitude };
  if (v.constructor && /DocumentReference/.test(v.constructor.name))
    return { __t: "ref", path: v.path };
  if (Buffer.isBuffer(v)) return { __t: "bytes", b64: v.toString("base64") };
  // Firestore Bytes (Uint8Array wrapper with toBase64)
  if (typeof v.toBase64 === "function") return { __t: "bytes", b64: v.toBase64() };
  if (Array.isArray(v)) return v.map(serializeValue);
  if (t === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const s = serializeValue(val);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return String(v); // last resort — never throw a backup away over one value
}

// ── Recursive collection streamer ────────────────────────────────────────────
// Walks a collection: pages of PAGE docs; for each page, probes subcollections
// with bounded concurrency and recurses. Calls onDoc(fullPath, dataObj).
async function walkCollection(colRef, onDoc) {
  let last = null;
  let count = 0;
  for (;;) {
    let q = colRef.orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      await onDoc(doc.ref.path, serializeValue(doc.data()));
      count += 1;
    }

    // Subcollection probe (bounded parallelism), then recurse serially so the
    // output stream stays ordered per file.
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += SUBPROBE_CONCURRENCY) {
      const batch = docs.slice(i, i + SUBPROBE_CONCURRENCY);
      const subLists = await Promise.all(batch.map((d) => d.ref.listCollections()));
      for (const subs of subLists) {
        for (const sub of subs) count += await walkCollection(sub, onDoc);
      }
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }
  return count;
}

// ── One collection → gzipped JSONL in the bucket ────────────────────────────
async function backupCollection(bucket, dateDir, colRef) {
  const object = `${FS_PREFIX}${dateDir}/${colRef.id}.jsonl.gz`;
  const gzip = zlib.createGzip({ level: 9 });
  const hash = crypto.createHash("sha256");
  const counter = new PassThrough();
  let gzBytes = 0;
  counter.on("data", (c) => {
    gzBytes += c.length;
    hash.update(c);
  });

  const dest = bucket.file(object).createWriteStream({
    resumable: false,
    contentType: "application/gzip",
    metadata: { cacheControl: "no-store" },
  });

  const done = pipeline(gzip, counter, dest);
  let docs = 0;
  const write = (line) =>
    new Promise((resolve, reject) => {
      const ok = gzip.write(line, (e) => (e ? reject(e) : undefined));
      if (ok) resolve();
      else gzip.once("drain", resolve); // backpressure → flat RSS
    });

  docs = await walkCollection(colRef, async (p, data) => {
    await write(JSON.stringify({ path: p, data }) + "\n");
  });

  gzip.end();
  await done;
  return { object, docs, gzBytes, sha256: hash.digest("hex") };
}

// ── Incremental bucket mirror (BDR4) ─────────────────────────────────────────
async function mirrorStorage(bucket) {
  const [files] = await bucket.getFiles();
  const sources = files.filter((f) => !f.name.startsWith("backups/"));
  const [mirrored] = await bucket.getFiles({ prefix: MIRROR_PREFIX });
  const mirrorMd5 = new Map(mirrored.map((f) => [f.name, f.metadata.md5Hash]));

  let copied = 0;
  const objects = [];
  for (const f of sources) {
    const dest = MIRROR_PREFIX + f.name;
    objects.push({
      path: f.name,
      size: Number(f.metadata.size || 0),
      md5: f.metadata.md5Hash || null,
      contentType: f.metadata.contentType || null,
    });
    if (mirrorMd5.get(dest) === f.metadata.md5Hash) continue; // unchanged
    await f.copy(bucket.file(dest));
    copied += 1;
  }
  return { total: sources.length, copied, objects };
}

// ── Retention pruning ────────────────────────────────────────────────────────
function isSunday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0;
}

async function pruneOldSnapshots(bucket) {
  const [files] = await bucket.getFiles({ prefix: FS_PREFIX });
  const dates = [...new Set(files.map((f) => f.name.slice(FS_PREFIX.length).split("/")[0]))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse(); // newest first

  const keep = new Set(dates.slice(0, KEEP_DAILY));
  for (const d of dates.filter(isSunday).slice(0, KEEP_WEEKLY)) keep.add(d);

  const doomed = dates.filter((d) => !keep.has(d));
  for (const d of doomed) {
    await bucket.deleteFiles({ prefix: `${FS_PREFIX}${d}/` });
  }
  return { kept: keep.size, pruned: doomed.length };
}

// ── Env-key inventory (BDR6: names + value hashes, never values) ─────────────
function envInventory() {
  const keys = Object.keys(process.env)
    .filter((k) => /^(FIREBASE_|ALERT_|OBS_|CERR_|RUM_|BACKUP_|JWT_|EDGE_|REDIS_|SMTP_|TELEGRAM_)/.test(k))
    .sort();
  return keys.map((k) => ({
    key: k,
    valueSha256_8: crypto.createHash("sha256").update(String(process.env[k])).digest("hex").slice(0, 8),
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Manila-local date: backups fire ~03:00 Asia/Manila; label with that day.
function manilaDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

async function runBackup({ db, storage } = {}) {
  if (!db || !storage) ({ db, storage } = require("../utils/firebase"));
  const bucket = storage.bucket();
  const dateDir = manilaDate();
  const startedAt = new Date();

  const manifest = {
    engine: ENGINE,
    date: dateDir,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    collections: {},
    totals: { docs: 0, gzBytes: 0 },
    storageMirror: null,
    envInventory: envInventory(),
  };

  const cols = await db.listCollections();
  for (const col of cols) {
    const r = await backupCollection(bucket, dateDir, col);
    manifest.collections[col.id] = { docs: r.docs, gzBytes: r.gzBytes, sha256: r.sha256 };
    manifest.totals.docs += r.docs;
    manifest.totals.gzBytes += r.gzBytes;
  }

  const mirror = await mirrorStorage(bucket);
  manifest.storageMirror = { total: mirror.total, copied: mirror.copied };
  // Object census rides inside the snapshot folder (what existed when).
  await bucket
    .file(`${FS_PREFIX}${dateDir}/storage-objects.json`)
    .save(JSON.stringify(mirror.objects, null, 1), { resumable: false, contentType: "application/json" });

  const prune = await pruneOldSnapshots(bucket);

  manifest.finishedAt = new Date().toISOString();
  manifest.durationMs = Date.now() - startedAt.getTime();
  await bucket
    .file(`${FS_PREFIX}${dateDir}/manifest.json`)
    .save(JSON.stringify(manifest, null, 1), { resumable: false, contentType: "application/json" });

  const summary = {
    ok: true,
    engine: ENGINE,
    date: dateDir,
    at: manifest.finishedAt,
    docs: manifest.totals.docs,
    collections: cols.length,
    gzBytes: manifest.totals.gzBytes,
    mirrorTotal: mirror.total,
    mirrorCopied: mirror.copied,
    snapshotsKept: prune.kept,
    snapshotsPruned: prune.pruned,
    durationMs: manifest.durationMs,
  };
  // Status doc drives the dashboard card + staleness alerting (BDR2).
  await db.collection("backups").doc("status").set(summary);
  return summary;
}

module.exports = { runBackup, serializeValue };

if (require.main === module) {
  runBackup()
    .then((s) => {
      console.log(
        `backup ok · ${s.date} · ${s.docs} docs / ${s.collections} collections · ` +
          `${(s.gzBytes / 1024).toFixed(0)} KB gz · mirror ${s.mirrorCopied}/${s.mirrorTotal} copied · ` +
          `kept ${s.snapshotsKept}, pruned ${s.snapshotsPruned} · ${(s.durationMs / 1000).toFixed(1)}s`
      );
      process.exit(0);
    })
    .catch((e) => {
      console.error("backup FAILED:", e.message);
      process.exit(1);
    });
}
