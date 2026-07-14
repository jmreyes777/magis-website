// tools/catalog-cutouts/generate.mjs
//
// Offline catalog-cutout generator. Runs in CI (GitHub Actions) or locally —
// NEVER on the live web server, so it adds zero runtime cost/attack surface to
// the site. It:
//   1. fetches the latest Facebook auction album (via the public backend API),
//   2. removes each photo's background with a FREE local model (@imgly),
//   3. trims transparent margins + clamps size + compresses to WebP (sharp),
//   4. writes transparent images to user-frontend/public/catalog-cutouts/,
//   5. writes manifest.json (the carousel's data source),
//   6. prunes cutouts for photos that left the album (keeps the folder small).
//
// Idempotent: a photo already cached is skipped (unless FORCE=1), so a fresh
// monthly album only processes the NEW photos.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { removeBackground } from "@imgly/background-removal-node";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config (env-overridable) ────────────────────────────────────────────────
const SOURCE_API = (process.env.SOURCE_API || "https://magis-website.onrender.com").replace(/\/$/, "");
const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.resolve(__dirname, "../../user-frontend/public/catalog-cutouts");
const PUBLIC_PREFIX = "/catalog-cutouts"; // URL path the SPA serves these from
const MAX_DIM = Number(process.env.MAX_DIM || 900); // px, longest side
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || 82);
const FORCE = process.env.FORCE === "1";

const log = (...a) => console.log("[cutouts]", ...a);

async function fetchAlbum() {
  const url = `${SOURCE_API}/api/facebook/albums/latest/photos`;
  log("fetching album:", url);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`album fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  return { albumId: data?.albumId || null, photos };
}

// FB's Graph API (and a backend cold start) can transiently report an EMPTY
// albums list — observed 2026-07-13: a new-album dispatch fired, yet 38s later
// the endpoint returned {albumId:null, photos:[]} and the run went red. Retry
// with backoff before believing an empty answer; errors retry the same way.
async function fetchAlbumWithRetry({ attempts = 4, delayMs = 45000 } = {}) {
  let last = { albumId: null, photos: [] };
  for (let i = 1; i <= attempts; i++) {
    try {
      last = await fetchAlbum();
      if (last.photos.length) return last;
      log(`attempt ${i}/${attempts}: album empty (albumId=${last.albumId})`);
    } catch (e) {
      log(`attempt ${i}/${attempts} failed: ${e?.message || e}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

function bestSource(photo) {
  const imgs = Array.isArray(photo.images) ? photo.images : [];
  // FB returns images largest-first; the largest gives the cleanest cutout.
  return imgs[0]?.src || null;
}

async function readManifest() {
  try {
    const raw = await fs.readFile(path.join(OUT_DIR, "manifest.json"), "utf8");
    const json = JSON.parse(raw);
    const map = new Map();
    for (const it of json.items || []) map.set(String(it.id), it);
    return map;
  } catch {
    return new Map();
  }
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function makeCutout(srcUrl) {
  const input = await downloadBuffer(srcUrl);
  // Decode to a real PNG first so @imgly reliably detects the format. Passing a
  // typeless Blob made it throw "Unsupported format". sharp also normalizes any
  // odd source encodings (CMYK JPEGs, etc.).
  const pngInput = await sharp(input).png().toBuffer();
  // remove background -> PNG with alpha
  const blob = await removeBackground(new Blob([pngInput], { type: "image/png" }), {
    output: { format: "image/png" },
  });
  let cut = Buffer.from(await blob.arrayBuffer());
  // trim fully-transparent margins so the subject fills the frame (guarded)
  try { cut = await sharp(cut).trim().png().toBuffer(); } catch { /* nothing to trim */ }
  const out = await sharp(cut)
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, alphaQuality: 90, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, w: out.info.width, h: out.info.height };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const prev = await readManifest();
  const { albumId, photos } = await fetchAlbumWithRetry();
  log(`album ${albumId} — ${photos.length} photos; ${prev.size} cached`);

  // Still empty after retries → KEEP the previous manifest/cutouts untouched.
  // A transient FB hiccup must not blank the live carousel (the daily cron
  // re-syncs a genuinely emptied album; use FORCE=1 to override manually).
  if (!photos.length && prev.size) {
    log("album still empty after retries — keeping previous manifest, no changes.");
    return;
  }

  const items = [];
  const liveIds = new Set();
  let made = 0, reused = 0, failed = 0;

  for (const p of photos) {
    const id = String(p.id);
    liveIds.add(id);
    const caption = p.caption || "";
    const file = `${id}.webp`;
    const fileAbs = path.join(OUT_DIR, file);

    let exists = false;
    try { await fs.access(fileAbs); exists = true; } catch { /* not cached */ }
    const cached = prev.get(id);

    if (!FORCE && cached && exists) {
      items.push({ id, caption, src: cached.src, w: cached.w, h: cached.h });
      reused++;
      continue;
    }

    const src = bestSource(p);
    if (!src) { failed++; log(`skip ${id}: no source image`); continue; }

    try {
      log(`cutout ${id} …`);
      const { buffer, w, h } = await makeCutout(src);
      await fs.writeFile(fileAbs, buffer);
      items.push({ id, caption, src: `${PUBLIC_PREFIX}/${file}`, w, h });
      made++;
    } catch (e) {
      failed++;
      log(`FAILED ${id}: ${e?.message || e}`);
    }
  }

  // Refuse to REPLACE a populated manifest with an empty one (all-photos-failed
  // case): leave the previous good state — files AND manifest — in place and
  // fail loudly instead. Must run BEFORE prune, which would delete every .webp.
  if (!items.length && prev.size) {
    log("every photo failed — previous manifest left untouched.");
    process.exitCode = 1;
    return;
  }

  // prune: delete any .webp not referenced by the current album
  let pruned = 0;
  const keep = new Set(items.map((i) => path.basename(i.src)));
  try {
    for (const f of await fs.readdir(OUT_DIR)) {
      if (f.endsWith(".webp") && !keep.has(f)) {
        await fs.rm(path.join(OUT_DIR, f), { force: true });
        pruned++;
      }
    }
  } catch { /* dir read race — ignore */ }

  const manifest = { generatedAt: new Date().toISOString(), albumId, count: items.length, items };
  await fs.writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  log(`done — made ${made}, reused ${reused}, pruned ${pruned}, failed ${failed}, total ${items.length}`);
  if (!items.length) process.exitCode = 1;
}

main().catch((e) => { console.error("[cutouts] fatal:", e); process.exit(1); });
