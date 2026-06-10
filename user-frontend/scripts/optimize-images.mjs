// user-frontend/scripts/optimize-images.mjs
// ---------------------------------------------------------------------------
// One-time optimizer for the oversized PNGs in public/images (PERF4-5).
// For each target it writes a resized WebP (served to modern browsers via the
// <picture> element) and OVERWRITES the .png with a resized/recompressed PNG
// fallback (only fetched by browsers without WebP support).
//
// sharp is intentionally NOT a committed dependency — this is a one-off asset
// step. To (re)run after replacing a source image:
//
//     cd user-frontend
//     npm install sharp --no-save
//     node scripts/optimize-images.mjs
//
// The generated .webp/.png files are committed; this script is kept only for
// reproducibility and is never imported by the app or the build.
// ---------------------------------------------------------------------------

import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const IMG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "images");

// longest-side cap (px) + WebP quality per asset
const PRODUCTS = ["ring", "earring", "bracelet", "chain", "necklace", "bangle", "pendant"];
const targets = [
  ...PRODUCTS.map((name) => ({ file: `${name}.png`, max: 800, qWebp: 80 })),
  // site logo (Header + Footer, every page) — rendered small, keep text crisp
  { file: "686421984_954054894279692_2045884033687314189_n.png", max: 480, qWebp: 85 },
];

const kb = (n) => `${(n / 1024).toFixed(0).padStart(5)} KB`;

let beforePng = 0;
let afterWebp = 0;
let afterPng = 0;

for (const t of targets) {
  const pngPath = join(IMG_DIR, t.file);
  const webpPath = pngPath.replace(/\.png$/i, ".webp");

  let input;
  try {
    // Read the original into a buffer first so we can safely overwrite the file.
    input = await readFile(pngPath);
  } catch {
    console.warn(`SKIP (missing): ${t.file}`);
    continue;
  }

  const meta = await sharp(input).metadata();
  const resize = { fit: "inside", withoutEnlargement: true };

  const webpBuf = await sharp(input)
    .resize(t.max, t.max, resize)
    .webp({ quality: t.qWebp, effort: 6 })
    .toBuffer();
  await writeFile(webpPath, webpBuf);

  const pngBuf = await sharp(input)
    .resize(t.max, t.max, resize)
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();
  await writeFile(pngPath, pngBuf);

  beforePng += input.length;
  afterWebp += webpBuf.length;
  afterPng += pngBuf.length;

  console.log(
    `${t.file}\n  ${meta.width}x${meta.height} ${kb(input.length)} (orig PNG)  ->  ` +
      `webp ${kb(webpBuf.length)} | png-fallback ${kb(pngBuf.length)}`
  );
}

console.log("\n--- totals ---");
console.log(`original PNG          : ${kb(beforePng)}`);
console.log(`shipped to modern (webp): ${kb(afterWebp)}`);
console.log(`png fallback (old only) : ${kb(afterPng)}`);
