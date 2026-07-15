// backend/scripts/firestore-restore.js
//
// BDR3 (backup & DR megaplan): restore tool for the JSONL.gz snapshots that
// scripts/firestore-backup.js produces. A backup you have never restored is a
// hope, not a backup — this tool exists so restores are routine (see --drill).
//
// Modes (safest first — the default touches NOTHING):
//   node scripts/firestore-restore.js --list
//     Show available snapshots (date, docs, collections, size, engine).
//
//   node scripts/firestore-restore.js [--date 2026-07-15] [--collections a,b]
//     DRY-RUN (default): stream the snapshot, verify each file's sha256
//     against the manifest, report what WOULD be written. No writes.
//
//   node scripts/firestore-restore.js --apply --into-prefix drill_ [...]
//     Restore into PREFIXED top-level collections (players → drill_players).
//     Safe next to live data. Subcollection paths keep their shape under the
//     prefixed root. NOTE: DocumentReference values are restored pointing at
//     their ORIGINAL (unprefixed) paths — fine for drills, by design.
//
//   node scripts/firestore-restore.js --apply --in-place --collections a,b --yes-i-know
//     The real thing (scenario: accidental wipe). Overwrites/creates docs at
//     their original paths (additive — never deletes docs the snapshot lacks).
//     Guardrails: requires an explicit collection list AND --yes-i-know.
//
//   node scripts/firestore-restore.js --drill [--keep]
//     Full quarterly drill: restore the latest snapshot into drill_* →
//     machine-verify (per-collection doc counts vs manifest + spot-check
//     random docs read back and value-compared) → delete drill_* (unless
//     --keep). Exits 0 only if every check passes. Record the output line
//     in BACKUP-DR-MEGAPLAN.md as drill evidence.
//
// Restore is value-symmetric with the backup's serializeValue: tagged
// {__t: ts|geo|ref|bytes} shapes are rebuilt as Timestamp/GeoPoint/
// DocumentReference/Buffer. (A user doc that organically contains a matching
// __t shape would be re-tagged — considered negligible; the backup engine
// only ever emits __t through tagging.)

const zlib = require("zlib");
const crypto = require("crypto");
const readline = require("readline");

const FS_PREFIX = "backups/firestore/";
const SPOT_CHECKS_PER_COLLECTION = 5;

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--list") a.list = true;
    else if (t === "--apply") a.apply = true;
    else if (t === "--in-place") a.inPlace = true;
    else if (t === "--yes-i-know") a.yesIKnow = true;
    else if (t === "--drill") a.drill = true;
    else if (t === "--keep") a.keep = true;
    else if (t === "--date") a.date = argv[++i];
    else if (t === "--into-prefix") a.intoPrefix = argv[++i];
    else if (t === "--collections") a.collections = argv[++i];
    else a._.push(t);
  }
  return a;
}

// ── Snapshot access ──────────────────────────────────────────────────────────
async function listSnapshotDates(bucket) {
  const [files] = await bucket.getFiles({ prefix: FS_PREFIX });
  return [...new Set(files.map((f) => f.name.slice(FS_PREFIX.length).split("/")[0]))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort(); // oldest → newest
}

async function readManifest(bucket, date) {
  const [buf] = await bucket.file(`${FS_PREFIX}${date}/manifest.json`).download();
  return JSON.parse(buf.toString("utf8"));
}

// Stream one collection's .jsonl.gz: onLine({path, data}) per doc line.
// Returns { lines, sha256 } — caller compares sha256 to the manifest.
async function streamSnapshotCollection(bucket, date, colId, onLine) {
  const object = `${FS_PREFIX}${date}/${colId}.jsonl.gz`;
  const hash = crypto.createHash("sha256");
  const src = bucket.file(object).createReadStream();
  src.on("data", (c) => hash.update(c));
  const rl = readline.createInterface({ input: src.pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    lines += 1;
    await onLine(JSON.parse(line));
  }
  return { lines, sha256: hash.digest("hex") };
}

// ── Value deserialization (inverse of backup's serializeValue) ───────────────
function makeDeserializer(admin, db) {
  return function deserializeValue(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(deserializeValue);
    if (v.__t === "ts" && typeof v.ms === "number") {
      const seconds = Math.floor(v.ms / 1000);
      const nanos = (v.ms - seconds * 1000) * 1e6 + (v.ns || 0);
      return new admin.firestore.Timestamp(seconds, nanos);
    }
    if (v.__t === "geo" && typeof v.lat === "number" && typeof v.lng === "number")
      return new admin.firestore.GeoPoint(v.lat, v.lng);
    if (v.__t === "ref" && typeof v.path === "string") return db.doc(v.path);
    if (v.__t === "bytes" && typeof v.b64 === "string") return Buffer.from(v.b64, "base64");
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = deserializeValue(val);
    return out;
  };
}

// Key-order-insensitive stringify for spot-check comparison.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}

// col/doc/sub/doc2 → <prefix>col/doc/sub/doc2 (prefix the TOP segment only).
function prefixPath(p, prefix) {
  if (!prefix) return p;
  const i = p.indexOf("/");
  return prefix + p.slice(0, i) + p.slice(i);
}

// ── Restore one collection ───────────────────────────────────────────────────
async function restoreCollection({ bucket, db, admin, date, colId, manifestEntry, prefix, apply, sampler }) {
  const deserialize = makeDeserializer(admin, db);
  const writer = apply ? db.bulkWriter() : null;
  if (writer) {
    writer.onWriteError((err) => {
      if (err.failedAttempts < 3) return true; // retry
      console.error(`  write FAILED after retries: ${err.documentRef.path}: ${err.message}`);
      return false;
    });
  }

  let written = 0;
  let failed = 0;
  let seen = 0;

  const { lines, sha256 } = await streamSnapshotCollection(bucket, date, colId, async (rec) => {
    seen += 1;
    if (sampler) sampler(seen, rec);
    if (!writer) return;
    const target = prefixPath(rec.path, prefix);
    writer
      .set(db.doc(target), deserialize(rec.data))
      .then(() => (written += 1))
      .catch(() => (failed += 1)); // already logged by onWriteError
  });

  if (writer) await writer.close();

  const shaOk = sha256 === manifestEntry.sha256;
  const countOk = lines === manifestEntry.docs;
  return { colId, lines, written, failed, shaOk, countOk };
}

// ── Drill verification: read sampled docs back and compare values ───────────
async function verifySamples(db, serializeValue, samples, prefix) {
  let pass = 0;
  const failures = [];
  for (const s of samples) {
    const target = prefixPath(s.path, prefix);
    const snap = await db.doc(target).get();
    if (!snap.exists) {
      failures.push(`${target}: MISSING`);
      continue;
    }
    const roundTripped = stableStringify(serializeValue(snap.data()));
    const original = stableStringify(s.data);
    if (roundTripped === original) pass += 1;
    else failures.push(`${target}: VALUE MISMATCH`);
  }
  return { pass, failures };
}

// Recursively delete a drill root collection (feature-detect recursiveDelete).
async function deleteCollectionTree(db, colId) {
  const ref = db.collection(colId);
  if (typeof db.recursiveDelete === "function") {
    await db.recursiveDelete(ref);
    return;
  }
  // Fallback: page through docs, recurse into subcollections, batch-delete.
  for (;;) {
    const snap = await ref.orderBy("__name__").limit(200).get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const subs = await doc.ref.listCollections();
      for (const sub of subs) await deleteCollectionTree(db, sub.path);
      await doc.ref.delete();
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { admin, db, storage } = require("../utils/firebase");
  const { serializeValue } = require("./firestore-backup");
  const bucket = storage.bucket();

  // ---- --list -----------------------------------------------------------
  if (args.list) {
    const dates = await listSnapshotDates(bucket);
    if (!dates.length) {
      console.log("no snapshots found under", FS_PREFIX);
      return 0;
    }
    for (const d of dates) {
      try {
        const m = await readManifest(bucket, d);
        console.log(
          `${d} · ${m.totals.docs} docs / ${Object.keys(m.collections).length} collections · ` +
            `${(m.totals.gzBytes / 1024).toFixed(0)} KB gz · ${(m.durationMs / 1000).toFixed(1)}s · ${m.engine}`
        );
      } catch {
        console.log(`${d} · (no readable manifest — incomplete snapshot?)`);
      }
    }
    return 0;
  }

  // ---- resolve snapshot + mode -------------------------------------------
  const dates = await listSnapshotDates(bucket);
  if (!dates.length) throw new Error(`no snapshots under ${FS_PREFIX} — run a backup first`);
  const date = args.date || dates[dates.length - 1];
  if (!dates.includes(date)) throw new Error(`snapshot ${date} not found; have: ${dates.join(", ")}`);
  const manifest = await readManifest(bucket, date);

  const drill = !!args.drill;
  const apply = drill || !!args.apply;
  let prefix = drill ? "drill_" : args.intoPrefix || "";
  const inPlace = !drill && !!args.inPlace;

  // ---- guardrails ----------------------------------------------------------
  if (apply && !drill) {
    if (inPlace && prefix) throw new Error("--in-place and --into-prefix are mutually exclusive");
    if (!inPlace && !prefix) throw new Error("--apply needs --into-prefix <p_> or --in-place (dry-run needs neither)");
    if (prefix && !/^[a-z0-9]+_$/i.test(prefix))
      throw new Error(`--into-prefix must look like "drill_" (letters/digits ending in _), got "${prefix}"`);
    if (inPlace) {
      if (!args.collections)
        throw new Error("--in-place requires an explicit --collections a,b — refusing a blanket overwrite");
      if (!args.yesIKnow)
        throw new Error("--in-place OVERWRITES live documents at their original paths. Re-run with --yes-i-know");
    }
  }

  const wanted = args.collections ? args.collections.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const colIds = Object.keys(manifest.collections)
    .filter((c) => !wanted || wanted.includes(c))
    .sort();
  if (wanted) {
    const missing = wanted.filter((w) => !manifest.collections[w]);
    if (missing.length) throw new Error(`not in snapshot ${date}: ${missing.join(", ")}`);
  }

  const mode = !apply ? "DRY-RUN" : drill ? "DRILL" : inPlace ? "IN-PLACE" : `INTO-PREFIX ${prefix}`;
  console.log(`restore ${mode} · snapshot ${date} · ${colIds.length} collections`);

  // ---- restore --------------------------------------------------------------
  const results = [];
  const allSamples = [];
  for (const colId of colIds) {
    // Reservoir sample while streaming (drill verification reads these back).
    const samples = [];
    const sampler = drill
      ? (i, rec) => {
          if (samples.length < SPOT_CHECKS_PER_COLLECTION) samples.push(rec);
          else {
            const j = Math.floor(Math.random() * i);
            if (j < SPOT_CHECKS_PER_COLLECTION) samples[j] = rec;
          }
        }
      : null;

    const r = await restoreCollection({
      bucket,
      db,
      admin,
      date,
      colId,
      manifestEntry: manifest.collections[colId],
      prefix: inPlace ? "" : prefix,
      apply,
      sampler,
    });
    results.push(r);
    allSamples.push(...samples);

    const flags = `${r.shaOk ? "sha✓" : "sha✗"} ${r.countOk ? "count✓" : "count✗"}`;
    if (apply)
      console.log(`  ${colId}: ${r.written} written${r.failed ? `, ${r.failed} FAILED` : ""} · ${flags}`);
    else console.log(`  ${colId}: would write ${r.lines} docs → ${prefixPath(colId + "/x", inPlace ? "" : prefix).split("/")[0]} · ${flags}`);
  }

  const totWritten = results.reduce((n, r) => n + r.written, 0);
  const totFailed = results.reduce((n, r) => n + r.failed, 0);
  const totLines = results.reduce((n, r) => n + r.lines, 0);
  const shaBad = results.filter((r) => !r.shaOk).map((r) => r.colId);
  const countBad = results.filter((r) => !r.countOk).map((r) => r.colId);

  // ---- drill verification + cleanup ----------------------------------------
  let verdict = 0;
  if (drill) {
    const { pass, failures } = await verifySamples(db, serializeValue, allSamples, prefix);
    const ok = !shaBad.length && !countBad.length && !totFailed && !failures.length;
    console.log(
      `drill ${ok ? "PASS" : "FAIL"} · ${totWritten}/${totLines} docs restored · ` +
        `spot-check ${pass}/${allSamples.length} ok · sha ${results.length - shaBad.length}/${results.length} ok`
    );
    for (const f of failures) console.error("  spot-check:", f);
    if (shaBad.length) console.error("  sha mismatch:", shaBad.join(", "));
    if (countBad.length) console.error("  count mismatch vs manifest:", countBad.join(", "));

    if (args.keep) console.log(`kept drill collections (drill_*) — clean up with: node scripts/firestore-restore.js --drill (runs cleanup) or delete manually`);
    else {
      for (const colId of colIds) await deleteCollectionTree(db, "drill_" + colId);
      console.log(`cleaned up ${colIds.length} drill_* collections`);
    }
    verdict = ok ? 0 : 1;
  } else if (apply) {
    console.log(`done · ${totWritten} written, ${totFailed} failed · sha ${shaBad.length ? "MISMATCH: " + shaBad.join(",") : "all ok"}`);
    verdict = totFailed || shaBad.length ? 1 : 0;
  } else {
    console.log(`dry-run done · ${totLines} docs in snapshot · sha ${shaBad.length ? "MISMATCH: " + shaBad.join(",") : "all ok"} · nothing written`);
    verdict = shaBad.length ? 1 : 0;
  }
  return verdict;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("restore FAILED:", e.message);
    process.exit(1);
  });
