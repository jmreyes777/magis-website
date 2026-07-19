// TST5 follow-up — /api/messages/reply contract, pinned after two prod bugs:
//
//   1. Image-only admin replies 400'd: the composer sends content="" as a
//      multipart field next to the file, and the zod schema's min(1) rejected
//      the empty string BEFORE the route's own content-or-file check could
//      accept the file. The schema must tolerate empty content; the route
//      still rejects when BOTH content and file are missing.
//   2. The gate itself: /reply must reject credential-less requests.
//
// Auth uses a real HMAC branchadmin JWT from the secret pool (same pattern as
// http.authgates). Storage is blanked in the harness, so a file upload that
// gets PAST validation may 500 at the storage step — the assertions therefore
// pin "not 400" (validation passed), never "201".
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { request, stop } = require("./httpHarness");
const { signJWT } = require("../utils/secretPool");

after(async () => {
  await stop();
});

const BRANCH = {
  role: "branchadmin",
  email: "branch@test.local",
  branchEmail: "branch@test.local",
  branchId: "branch-test",
  branchName: "Test Branch",
};

const branchToken = () => signJWT(BRANCH, { expiresIn: "5m" });

// Minimal valid GIF87a file — enough for multer's mimetype filter (which
// trusts the declared Content-Type, not magic bytes).
const TINY_GIF = Buffer.from("47494638376101000100800000000000ffffff2c00000000010001000002024c01003b", "hex");

function multipartBody(fields, file) {
  const boundary = "----test-boundary-" + Date.now();
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`
      ),
      file.data,
      Buffer.from("\r\n")
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("POST /api/messages/reply — auth gate", () => {
  test("credential-less request is rejected (401/403, JSON error)", async () => {
    const res = await request("/api/messages/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestId: "g-1", content: "hello" }),
    });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
    assert.equal(typeof res.json?.error, "string");
  });
});

describe("POST /api/messages/reply — content-or-file validation", () => {
  test("no content AND no file → 400 with a clear error", async () => {
    const token = await branchToken();
    const res = await request("/api/messages/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ guestId: "g-1", branchEmail: BRANCH.email }),
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
    assert.match(res.json.error, /content|media/i);
  });

  test("image-only reply (content=\"\" beside the file) passes validation — regression", async () => {
    // Before the fix: 400 "content is required." from zod min(1). After: the
    // request clears validation; in the harness it then hits blanked storage,
    // so ANY status except 400 proves the schema accepted it.
    const token = await branchToken();
    const { body, contentType } = multipartBody(
      { guestId: "g-1", branchEmail: BRANCH.email, content: "" },
      { field: "media", name: "photo.gif", type: "image/gif", data: TINY_GIF }
    );
    const res = await request("/api/messages/reply", {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    assert.notEqual(
      res.status,
      400,
      `image-only reply must not be rejected by validation, got 400: ${res.text}`
    );
  });

  test("text-only reply passes validation (control)", async () => {
    const token = await branchToken();
    const res = await request("/api/messages/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ guestId: "g-1", branchEmail: BRANCH.email, content: "hello" }),
    });
    assert.notEqual(res.status, 400, `text reply must pass validation, got 400: ${res.text}`);
    assert.notEqual(res.status, 401, "token must authenticate");
    assert.notEqual(res.status, 403, "branchEmail must match token");
  });
});

describe("POST /api/messages/reply — upload wire contract (any device)", () => {
  // The old allow-list 415'd/500'd the exact uploads phones fall back to when
  // the client-side canvas optimizer can't decode a format. The wire must now
  // accept ANY image/* mimetype (+ octet-stream from mislabeling share
  // sheets); the server-side normalizer is the byte-level gatekeeper.
  const sendFile = async (file) => {
    const token = await branchToken();
    const { body, contentType } = multipartBody(
      { guestId: "g-1", branchEmail: BRANCH.email, content: "" },
      file
    );
    return request("/api/messages/reply", {
      method: "POST",
      headers: { "Content-Type": contentType, Authorization: `Bearer ${token}` },
      body,
    });
  };

  test("HEIC mimetype is no longer rejected at the wire (iPhone regression)", async () => {
    const res = await sendFile({
      field: "media",
      name: "IMG_0001.heic",
      type: "image/heic",
      data: TINY_GIF, // bytes irrelevant here: asserting the FILTER verdict only
    });
    assert.notEqual(res.status, 415, `HEIC must pass the mimetype filter: ${res.text}`);
    // Junk bytes labeled HEIC then fail DECODE with the friendly 422 (or 500
    // at blanked storage if decode were skipped — 422 proves the normalizer
    // saw it).
    if (res.status === 422) {
      assert.match(res.json.error, /photo format|readable image/i);
    }
  });

  test("WebP mimetype passes the wire filter (Android screenshot regression)", async () => {
    const res = await sendFile({
      field: "media",
      name: "screenshot.webp",
      type: "image/webp",
      data: TINY_GIF,
    });
    assert.notEqual(res.status, 415, `WebP must pass the filter: ${res.text}`);
  });

  test("octet-stream (mislabeling share sheet) passes the wire filter", async () => {
    const res = await sendFile({
      field: "media",
      name: "photo",
      type: "application/octet-stream",
      data: TINY_GIF,
    });
    assert.notEqual(res.status, 415, `octet-stream must reach the normalizer: ${res.text}`);
  });

  test("executables are still rejected with a friendly 415", async () => {
    const res = await sendFile({
      field: "media",
      name: "malware.exe",
      type: "application/x-msdownload",
      data: Buffer.from("MZ"),
    });
    assert.equal(res.status, 415, `expected 415, got ${res.status}: ${res.text}`);
    assert.match(res.json.error, /images and PDF/i);
  });

  test("un-decodable bytes under an image label → friendly 422, not a 500", async () => {
    const res = await sendFile({
      field: "media",
      name: "junk.png",
      type: "image/png",
      data: Buffer.from("not an image at all ".repeat(32)),
    });
    assert.equal(res.status, 422, `expected 422, got ${res.status}: ${res.text}`);
    assert.match(res.json.error, /readable image/i);
  });

  test("oversized upload → friendly 413 naming the 25MB cap", async () => {
    const res = await sendFile({
      field: "media",
      name: "huge.jpg",
      type: "image/jpeg",
      data: Buffer.alloc(26 * 1024 * 1024, 7),
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.text}`);
    assert.match(res.json.error, /25MB/);
  });

  test("valid GIF passes filter + normalizer untouched (animation-safe path)", async () => {
    const res = await sendFile({
      field: "media",
      name: "anim.gif",
      type: "image/gif",
      data: TINY_GIF,
    });
    // Filter ✓, normalizer passthrough ✓ — then the harness's blanked storage
    // is the only thing that can stop it. Anything but 4xx proves the chat
    // pipeline accepted the file.
    assert.ok(res.status >= 500 || res.status === 201, `expected pass-through, got ${res.status}: ${res.text}`);
  });
});
