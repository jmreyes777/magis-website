// Chat image normalizer — the server-side guarantee behind "any device, any
// size" attachments (2026-07-19 incident: phone uploads failed whenever the
// client-side canvas optimizer couldn't decode the format and the original
// hit the old jpeg/png/gif allow-list + 5MB cap).
//
// Fixtures are GENERATED with sharp itself — no binary blobs in the repo.
// HEIC end-to-end is not covered (no encoder available); the byte-sniff that
// routes HEIC into heic-convert is covered as pure logic.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const {
  normalizeChatImage,
  safeBaseName,
  looksLikeHeic,
  MAX_DIMENSION_PX,
  OUTPUT_HARD_CAP_BYTES,
} = require("../utils/chatImageNormalizer");

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------
const bigJpeg = () =>
  sharp({
    create: { width: 2400, height: 1200, channels: 3, background: "#c07000" },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

const alphaPng = () =>
  sharp({
    create: {
      width: 500,
      height: 300,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.4 },
    },
  })
    .png()
    .toBuffer();

const webpImage = () =>
  sharp({
    create: { width: 900, height: 900, channels: 3, background: "#004488" },
  })
    .webp({ quality: 85 })
    .toBuffer();

const smallJpeg = () =>
  sharp({
    create: { width: 400, height: 250, channels: 3, background: "#222222" },
  })
    .jpeg()
    .toBuffer();

const smallGif = () =>
  sharp({
    create: { width: 120, height: 90, channels: 3, background: "#00aa00" },
  })
    .gif()
    .toBuffer();

// ---------------------------------------------------------------------------

describe("normalizeChatImage", () => {
  test("oversized JPEG is downscaled to ≤1600px JPEG", async () => {
    const out = await normalizeChatImage(await bigJpeg(), "image/jpeg");
    assert.equal(out.contentType, "image/jpeg");
    assert.equal(out.ext, "jpg");
    assert.equal(out.changed, true);
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width <= MAX_DIMENSION_PX, `width ${meta.width}`);
    assert.ok(meta.height <= MAX_DIMENSION_PX, `height ${meta.height}`);
    // 2400x1200 → 1600x800 (aspect preserved)
    assert.equal(meta.width, 1600);
    assert.equal(meta.height, 800);
    assert.ok(out.buffer.length <= OUTPUT_HARD_CAP_BYTES);
  });

  test("transparency is preserved: alpha PNG stays PNG with alpha", async () => {
    const out = await normalizeChatImage(await alphaPng(), "image/png");
    assert.equal(out.contentType, "image/png");
    assert.equal(out.ext, "png");
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.hasAlpha, true);
  });

  test("WebP (Android screenshots) becomes browser-safe JPEG", async () => {
    const out = await normalizeChatImage(await webpImage(), "image/webp");
    assert.equal(out.contentType, "image/jpeg");
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 900); // withoutEnlargement: no upscale
  });

  test("mislabeled mimetype is irrelevant — bytes win (webp as octet-stream)", async () => {
    const out = await normalizeChatImage(await webpImage(), "application/octet-stream");
    assert.equal(out.contentType, "image/jpeg");
  });

  test("small images are never enlarged", async () => {
    const out = await normalizeChatImage(await smallJpeg(), "image/jpeg");
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 250);
  });

  test("small GIF passes through byte-identical (animation-safe)", async () => {
    const gif = await smallGif();
    const out = await normalizeChatImage(gif, "image/gif");
    assert.equal(out.changed, false);
    assert.equal(out.contentType, "image/gif");
    assert.equal(out.ext, "gif");
    assert.ok(gif.equals(out.buffer), "buffer must be untouched");
  });

  test("garbage bytes produce a friendly, user-fixable error", async () => {
    const junk = Buffer.from("this is definitely not an image ".repeat(64));
    await assert.rejects(
      () => normalizeChatImage(junk, "image/png"),
      (err) => {
        assert.equal(err.friendly, true);
        assert.match(err.message, /JPEG, PNG, GIF, or WebP/);
        return true;
      }
    );
  });
});

describe("looksLikeHeic byte sniff", () => {
  const heicHeader = (brand) => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0); // box size
    buf.write("ftyp", 4, "ascii");
    buf.write(brand, 8, "ascii");
    return buf;
  };

  test("recognizes iPhone brands (heic/mif1) regardless of declared mimetype", () => {
    assert.equal(looksLikeHeic(heicHeader("heic")), true);
    assert.equal(looksLikeHeic(heicHeader("mif1")), true);
    assert.equal(looksLikeHeic(heicHeader("heix")), true);
  });

  test("ignores non-HEIC ISO-BMFF (mp4) and ordinary images", async () => {
    assert.equal(looksLikeHeic(heicHeader("isom")), false);
    assert.equal(looksLikeHeic(await smallJpeg()), false);
    assert.equal(looksLikeHeic(Buffer.alloc(4)), false);
    assert.equal(looksLikeHeic(null), false);
  });
});

describe("safeBaseName", () => {
  test("slugs spaces/parens/emoji and caps length", () => {
    assert.equal(safeBaseName("INTEREST RATES (Dolores) [2026].png"), "INTEREST-RATES-Dolores-2026");
    assert.equal(safeBaseName("réçu 💍 photo.jpeg"), "r-u-photo");
    assert.ok(safeBaseName("x".repeat(300) + ".png").length <= 40);
  });

  test("degenerate names fall back to 'image'", () => {
    assert.equal(safeBaseName("💍💍💍.heic"), "image");
    assert.equal(safeBaseName(""), "image");
    assert.equal(safeBaseName(undefined), "image");
  });
});
