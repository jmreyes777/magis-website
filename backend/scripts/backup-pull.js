// backend/scripts/backup-pull.js
//
// BDR5 (backup & DR megaplan): off-cloud pull mirror. Copies the newest N
// Firestore snapshot folders AND the storage-objects mirror from the bucket
// down to this PC, hash-verifying every byte. Covers the disaster class that
// in-bucket backups cannot: losing the Firebase project / Google account.
//
//   node scripts/backup-pull.js                      pull newest 7 snapshots + media
//   node scripts/backup-pull.js --days 30            pull newest 30 snapshots
//   node scripts/backup-pull.js --dest D:\magis-backups
//   node scripts/backup-pull.js --skip-media         snapshots only
//
// Behavior:
//   - Incremental: a file whose local hash already matches (sha256 vs the
//     snapshot manifest; md5 vs GCS object metadata for media) is skipped —
//     re-runs are cheap, and silent local corruption/tampering is REPAIRED.
//   - Atomic-ish: downloads land in <file>.part, verified, then renamed.
//   - NEVER deletes anything locally. An off-cloud archive that auto-prunes
//     is one bug away from being no archive at all; prune by hand.
//   - Exit 0 = everything pulled & verified. Exit 1 = at least one failure
//     (Task Scheduler surfaces this via the Last Run Result column).
//
// Local layout (default dest C:\magis-backups — override with --dest or
// BACKUP_PULL_DEST; keep the folder on a BitLocker-encrypted drive, the
// snapshots contain conversationKeys — see BDR0 census note):
//   <dest>\firestore\YYYY-MM-DD\*.jsonl.gz + manifest.json + storage-objects.json
//   <dest>\storage-objects\media\…            (bucket mirror, md5-verified)
//
// Weekly schedule (documented in DR-RUNBOOK.md): Task Scheduler → weekly →
//   Program:  node
//   Args:     scripts\backup-pull.js
//   Start in: C:\Users\jmrey\magis-website-new\backend

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FS_PREFIX = "backups/firestore/";
const MIRROR_PREFIX = "backups/storage-objects/";

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--days") a.days = parseInt(argv[++i], 10);
    else if (t === "--dest") a.dest = argv[++i];
    else if (t === "--skip-media") a.skipMedia = true;
  }
  return a;
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest(algo === "md5" ? "base64" : "hex")))
      .on("error", reject);
  });
}

// Download object → <local>.part, verify hash, rename into place.
// verify: { algo: "sha256"|"md5", want: <hex|base64> } (md5 compares base64,
// matching the GCS md5Hash metadata format).
async function pullObject(bucket, objectName, local, verify) {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const part = local + ".part";
  await bucket.file(objectName).download({ destination: part });
  if (verify && verify.want) {
    const got = await hashFile(part, verify.algo);
    if (got !== verify.want) {
      fs.rmSync(part, { force: true });
      throw new Error(`${objectName}: ${verify.algo} mismatch after download (want ${verify.want}, got ${got})`);
    }
  }
  fs.renameSync(part, local);
  return fs.statSync(local).size;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 7;
  const dest = args.dest || process.env.BACKUP_PULL_DEST || "C:\\magis-backups";
  const t0 = Date.now();

  const { storage } = require("../utils/firebase");
  const bucket = storage.bucket();

  // ── snapshots ──────────────────────────────────────────────────────────────
  const [fsFiles] = await bucket.getFiles({ prefix: FS_PREFIX });
  const dates = [...new Set(fsFiles.map((f) => f.name.slice(FS_PREFIX.length).split("/")[0]))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .slice(-days);
  if (!dates.length) throw new Error(`no snapshots under ${FS_PREFIX} — nothing to pull`);

  let filesVerified = 0;
  let filesDownloaded = 0;
  let bytesDownloaded = 0;
  let newSnapshots = 0;
  const failures = [];

  for (const date of dates) {
    const dir = path.join(dest, "firestore", date);
    const hadDir = fs.existsSync(path.join(dir, "manifest.json"));
    if (!hadDir) newSnapshots += 1;

    // Manifest first — it is the source of truth for the rest of the folder.
    // Always refreshed (tiny; also self-heals a torn previous pull).
    const manifestLocal = path.join(dir, "manifest.json");
    try {
      bytesDownloaded += await pullObject(bucket, `${FS_PREFIX}${date}/manifest.json`, manifestLocal, null);
      filesDownloaded += 1;
    } catch (e) {
      failures.push(e.message);
      continue; // without a manifest nothing below is verifiable
    }
    const manifest = JSON.parse(fs.readFileSync(manifestLocal, "utf8"));

    // storage-objects.json census (tiny, refresh alongside the manifest).
    try {
      bytesDownloaded += await pullObject(bucket, `${FS_PREFIX}${date}/storage-objects.json`, path.join(dir, "storage-objects.json"), null);
      filesDownloaded += 1;
    } catch (e) {
      failures.push(e.message); // old snapshots may predate the census — still record it
    }

    // Collection files, sha256-checked against the manifest.
    for (const [colId, entry] of Object.entries(manifest.collections)) {
      const local = path.join(dir, `${colId}.jsonl.gz`);
      try {
        if (fs.existsSync(local) && (await hashFile(local, "sha256")) === entry.sha256) {
          filesVerified += 1; // already present & intact
          continue;
        }
        bytesDownloaded += await pullObject(bucket, `${FS_PREFIX}${date}/${colId}.jsonl.gz`, local, {
          algo: "sha256",
          want: entry.sha256,
        });
        filesDownloaded += 1;
        filesVerified += 1;
      } catch (e) {
        failures.push(e.message);
      }
    }
  }

  // ── media mirror ───────────────────────────────────────────────────────────
  let mediaTotal = 0;
  let mediaNew = 0;
  if (!args.skipMedia) {
    const [mirror] = await bucket.getFiles({ prefix: MIRROR_PREFIX });
    mediaTotal = mirror.length;
    for (const f of mirror) {
      // backups/storage-objects/media/x.jpg → <dest>\storage-objects\media\x.jpg
      const rel = f.name.slice("backups/".length).split("/");
      const local = path.join(dest, ...rel);
      const wantMd5 = f.metadata.md5Hash || null;
      try {
        if (fs.existsSync(local) && wantMd5 && (await hashFile(local, "md5")) === wantMd5) continue;
        bytesDownloaded += await pullObject(bucket, f.name, local, wantMd5 ? { algo: "md5", want: wantMd5 } : null);
        mediaNew += 1;
      } catch (e) {
        failures.push(e.message);
      }
    }
  }

  // ── one-line verdict ───────────────────────────────────────────────────────
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const mb = (bytesDownloaded / 1024 / 1024).toFixed(1);
  const media = args.skipMedia ? "media skipped" : `media ${mediaTotal - mediaNew} intact + ${mediaNew} new`;
  if (failures.length) {
    console.error(
      `pull FAILED · ${failures.length} error(s) · ${filesDownloaded} downloaded (${mb} MB) · ${media} · ${secs}s → ${dest}`
    );
    for (const f of failures) console.error("  ", f);
    return 1;
  }
  console.log(
    `pull ok · ${dates.length} snapshot(s), ${newSnapshots} new · ${filesVerified} files verified · ` +
      `${filesDownloaded} downloaded (${mb} MB) · ${media} · ${secs}s → ${dest}`
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("pull FAILED:", e.message);
    process.exit(1);
  });
