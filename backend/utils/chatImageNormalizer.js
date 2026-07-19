// backend/utils/chatImageNormalizer.js
//
// Server-side image normalization for chat attachments (guest /send and
// branch-admin /reply). The client-side canvas optimizer is best-effort only:
// when a browser cannot DECODE a format (HEIC on Chrome/Android/Windows,
// TIFF, exotic camera formats), the frontends fall back to sending the
// ORIGINAL file. Before this module, that original then hit a narrow multer
// allow-list (jpeg/png/gif/pdf) and a 5MB cap — the exact combination behind
// "images don't send from my phone".
//
// This module makes the SERVER the guarantee instead:
//   any decodable image, any size (≤25MB wire cap)
//     → EXIF-rotated, ≤1600px, browser-safe JPEG or PNG, typically <500KB
//
// Rules:
//   - GIFs pass through untouched (canvas/sharp re-encode would cost the
//     animation; they were already an allowed type).
//   - Alpha images stay PNG (transparency preserved); everything else becomes
//     JPEG (quality 80, mozjpeg).
//   - HEIC/HEIF decodes via heic-convert (pure-JS libheif) because prebuilt
//     sharp binaries ship without HEIF support (patent licensing).
//   - Output is hard-capped: a pathological result >5MB gets one flatten+q60
//     retry, then a friendly error. Storage never bloats.
//
// Exposed for tests: MAX_DIMENSION_PX, OUTPUT_HARD_CAP_BYTES.

const sharp = require("sharp");

const MAX_DIMENSION_PX = 1600;
const JPEG_QUALITY = 80;
const GIF_PASSTHROUGH_MAX_BYTES = 5 * 1024 * 1024;
const OUTPUT_HARD_CAP_BYTES = 5 * 1024 * 1024;

// HEIC/HEIF sniff: ISO-BMFF "ftyp" box at offset 4 with a heic/heif/mif1 brand.
// Needed because browsers sometimes send HEIC bytes under a generic mimetype
// (or octet-stream via share sheets) — trust the bytes, not the label.
function looksLikeHeic(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = buffer.toString("ascii", 8, 12).toLowerCase();
  return ["heic", "heix", "heim", "heis", "hevc", "hevx", "heif", "mif1", "msf1"].some(
    (b) => brand.startsWith(b.slice(0, 4))
  );
}

async function heicToJpegBuffer(buffer) {
  // Lazy require: heic-convert bundles a WASM libheif — only pay the load
  // cost on the (rare) request that actually needs it.
  const heicConvert = require("heic-convert");
  const out = await heicConvert({ buffer, format: "JPEG", quality: 0.9 });
  return Buffer.from(out);
}

/**
 * Normalize a chat image to a browser-safe, size-bounded format.
 *
 * @param {Buffer} buffer   raw upload bytes
 * @param {string} mimetype mimetype as declared by the client (advisory only)
 * @returns {Promise<{buffer: Buffer, contentType: string, ext: string, changed: boolean}>}
 * @throws  Error with .friendly=true when the bytes are not a decodable image
 */
async function normalizeChatImage(buffer, mimetype = "") {
  const declared = String(mimetype || "").toLowerCase();

  // Animated GIFs: re-encoding loses the animation; pass through unchanged
  // while small enough. Oversized GIFs fall through to the pipeline below and
  // come back as a first-frame JPEG (documented trade-off).
  if (declared === "image/gif" && buffer.length <= GIF_PASSTHROUGH_MAX_BYTES) {
    return { buffer, contentType: "image/gif", ext: "gif", changed: false };
  }

  // HEIC first when the bytes say so — sharp's prebuilt libvips can't read it.
  let working = buffer;
  if (declared === "image/heic" || declared === "image/heif" || looksLikeHeic(buffer)) {
    try {
      working = await heicToJpegBuffer(buffer);
    } catch (err) {
      const e = new Error(
        "This photo format could not be read. Please send it as a JPEG or PNG."
      );
      e.friendly = true;
      e.cause = err;
      throw e;
    }
  }

  let img = sharp(working, { failOn: "truncated" });
  let meta;
  try {
    meta = await img.metadata();
  } catch (err) {
    // Last-chance rescue: mislabeled HEIC that dodged the sniff (rare).
    if (working === buffer && !looksLikeHeic(buffer)) {
      try {
        working = await heicToJpegBuffer(buffer);
        img = sharp(working, { failOn: "truncated" });
        meta = await img.metadata();
      } catch (_) {
        const e = new Error(
          "That file doesn't look like a readable image. Please send a JPEG, PNG, GIF, or WebP."
        );
        e.friendly = true;
        e.cause = err;
        throw e;
      }
    } else {
      const e = new Error(
        "That file doesn't look like a readable image. Please send a JPEG, PNG, GIF, or WebP."
      );
      e.friendly = true;
      e.cause = err;
      throw e;
    }
  }

  const keepPng = !!meta.hasAlpha;
  // .rotate() with no args applies the EXIF orientation, so phone photos stop
  // arriving sideways; resize never enlarges small images.
  let pipeline = img
    .rotate()
    .resize(MAX_DIMENSION_PX, MAX_DIMENSION_PX, {
      fit: "inside",
      withoutEnlargement: true,
    });

  let out;
  if (keepPng) {
    out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (out.length > OUTPUT_HARD_CAP_BYTES) {
      // Alpha PNG that stays huge even at ≤1600px: flatten onto white and take
      // the JPEG — transparency loss beats a failed send.
      out = await sharp(working)
        .rotate()
        .resize(MAX_DIMENSION_PX, MAX_DIMENSION_PX, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 60, mozjpeg: true })
        .toBuffer();
    } else {
      return { buffer: out, contentType: "image/png", ext: "png", changed: true };
    }
  } else {
    out = await pipeline
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    if (out.length > OUTPUT_HARD_CAP_BYTES) {
      out = await sharp(working)
        .rotate()
        .resize(MAX_DIMENSION_PX, MAX_DIMENSION_PX, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 60, mozjpeg: true })
        .toBuffer();
    }
  }

  if (out.length > OUTPUT_HARD_CAP_BYTES) {
    const e = new Error(
      "This image could not be compressed to a sendable size. Please try a smaller image."
    );
    e.friendly = true;
    throw e;
  }
  return { buffer: out, contentType: "image/jpeg", ext: "jpg", changed: true };
}

// Storage object names previously interpolated the raw client filename —
// spaces, parentheses, emoji and 200-char names all ended up in object keys.
// Keep a short, safe slug purely for human readability of the bucket.
function safeBaseName(originalName = "image") {
  const base = String(originalName)
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "image";
}

module.exports = {
  normalizeChatImage,
  safeBaseName,
  looksLikeHeic,
  MAX_DIMENSION_PX,
  OUTPUT_HARD_CAP_BYTES,
};
