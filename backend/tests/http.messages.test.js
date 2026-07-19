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
