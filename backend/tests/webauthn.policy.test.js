// Passkey platform-only policy contracts (routes/webauthn.js).
//
// These pin the invariants that keep browsers OUT of the cross-device QR /
// phone / security-key picker — a regression here only shows up on real
// hardware (the Windows "Choose a passkey" dialog), never in a stack trace:
//   1. /login-options REQUIRES an email (usernameless flow = QR picker).
//   2. allowCredentials transports are forced to ["internal"], even for
//      credentials stored with legacy hybrid/usb transports.
//   3. Unknown emails get a stable HMAC decoy — same response shape as a real
//      account (anti-enumeration), unpredictable without the server secret.
//   4. userVerification is "required" (PIN/biometric, never presence-only).
//   5. Registration pins authenticatorAttachment: "platform" and the verify
//      step rejects attestations produced by anything else (e.g. a phone).
//   6. hints: ["client-device"] rides along on every options payload.
//
// Runs the REAL router with a require-cache fake standing in for Firestore
// (mirrors utils/firebase's export surface); JWTs are real HS256 via the
// worker-backed secretPool, so the full auth + MFA middleware chain executes.

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "webauthn-policy-test-secret-0123456789abcdef";
process.env.REDIS_URL = "";
process.env.PASSKEYS_ENABLED = "true";
process.env.WEBAUTHN_RP_ID = "admin.test";
process.env.WEBAUTHN_ORIGINS = "https://admin.test";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// ── In-memory Firestore fake (the subset webauthn/requireMFA/auditLog use) ───
const stores = new Map(); // collection name -> Map(docId -> data)
function col(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}
const fakeDb = {
  collection(name) {
    const m = col(name);
    const query = (filters) => ({
      where: (field, _op, value) => query([...filters, [field, value]]),
      async get() {
        const docs = [];
        for (const [id, data] of m) {
          if (filters.every(([f, v]) => data[f] === v)) {
            docs.push({ id, data: () => data, ref: fakeDb.collection(name).doc(id) });
          }
        }
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    });
    return {
      doc(id) {
        return {
          id,
          async get() {
            const data = m.get(id);
            return {
              exists: data !== undefined,
              id,
              data: () => data,
              ref: fakeDb.collection(name).doc(id),
            };
          },
          async set(data, opts) {
            m.set(id, opts && opts.merge ? { ...m.get(id), ...data } : data);
          },
          async update(patch) {
            if (!m.has(id)) throw new Error("not-found");
            m.set(id, { ...m.get(id), ...patch });
          },
          async delete() { m.delete(id); },
        };
      },
      where: (field, _op, value) => query([[field, value]]),
      async add(data) {
        const id = `auto-${m.size + 1}-${Date.now()}`;
        m.set(id, data);
        return fakeDb.collection(name).doc(id);
      },
    };
  },
};

// Stand-in registered BEFORE any app module loads (must mirror the real
// module's export surface — routes destructure { db, admin } etc.).
const fbPath = require.resolve("../utils/firebase");
require.cache[fbPath] = {
  id: fbPath,
  filename: fbPath,
  loaded: true,
  exports: {
    admin: { firestore: Object.assign(() => fakeDb, { FieldValue: {} }) },
    db: fakeDb,
    storage: null,
    initFirebase: () => {},
    uploadToStorage: async () => { throw new Error("no storage in tests"); },
    assignCustomClaims: async () => {},
    getCustomClaims: async () => ({}),
  },
};

const express = require("express");
const webauthnRouter = require("../routes/webauthn");
const { signJWT, shutdown } = require("../utils/secretPool");

const ADMIN = {
  email: "admin@magis.test",
  branchId: "branch-1",
  branchName: "Test Branch",
};

let server;
let baseUrl;
let authToken;

function request(path, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      baseUrl + path,
      {
        method,
        agent: false, // no keep-alive handles at --test-force-exit teardown
        headers: { "Content-Type": "application/json", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const authed = (path, body) =>
  request(path, { body, headers: { Authorization: `Bearer ${authToken}` } });

before(async () => {
  const app = express();
  app.use(express.json()); // server.js provides the global parser in prod
  app.use("/api/webauthn", webauthnRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  authToken = await signJWT(
    { role: "branchadmin", ...ADMIN, uid: "uid-1", fallback: true },
    { expiresIn: "5m" }
  );
  // Active MFA session → requireMFA passes via its any-active-session fallback.
  col("mfa_sessions").set(`${ADMIN.email}_test-session`, {
    email: ADMIN.email,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    geoLocked: false,
  });
  // One legacy hybrid/usb credential, one internal, one disabled: sign-in must
  // offer exactly the two enabled ids and force transports to ["internal"].
  col("webauthnCredentials").set("cred-legacy_1", {
    email: ADMIN.email,
    disabled: false,
    transports: ["hybrid", "usb"],
    publicKey: "AAAA",
    counter: 0,
  });
  col("webauthnCredentials").set("cred-internal_2", {
    email: ADMIN.email,
    disabled: false,
    transports: ["internal"],
    publicKey: "BBBB",
    counter: 0,
  });
  col("webauthnCredentials").set("cred-revoked_3", {
    email: ADMIN.email,
    disabled: true,
    transports: ["internal"],
    publicKey: "CCCC",
    counter: 0,
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // Worker pool holds MessagePort handles that race libuv teardown on Windows.
  try { await shutdown(); } catch { /* already down */ }
});

// ── Sign-in options ──────────────────────────────────────────────────────────
describe("POST /api/webauthn/login-options — platform-only contract", () => {
  test("email is required (usernameless flow would open the QR picker)", async () => {
    const r = await request("/api/webauthn/login-options", { body: {} });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /email/i);
  });

  test("enrolled account: only enabled ids, transports forced to [\"internal\"], UV required, client-device hint", async () => {
    const r = await request("/api/webauthn/login-options", { body: { email: ADMIN.email } });
    assert.equal(r.status, 200);
    const o = r.json.options;
    assert.equal(o.rpId, "admin.test");
    assert.equal(o.userVerification, "required");
    assert.deepEqual(o.hints, ["client-device"]);
    const ids = o.allowCredentials.map((c) => c.id).sort();
    assert.deepEqual(ids, ["cred-internal_2", "cred-legacy_1"]); // revoked one absent
    for (const c of o.allowCredentials) {
      assert.deepEqual(c.transports, ["internal"]); // hybrid/usb never offered
    }
    assert.ok(r.json.challengeId);
  });

  test("unknown email: decoy has the same shape/policy and is stable per email", async () => {
    const known = await request("/api/webauthn/login-options", { body: { email: ADMIN.email } });
    const a = await request("/api/webauthn/login-options", { body: { email: "ghost@magis.test" } });
    const b = await request("/api/webauthn/login-options", { body: { email: "ghost@magis.test" } });
    const c = await request("/api/webauthn/login-options", { body: { email: "other@magis.test" } });

    for (const r of [a, b, c]) {
      assert.equal(r.status, 200);
      // Indistinguishable response shape from a real account's.
      assert.deepEqual(Object.keys(r.json).sort(), Object.keys(known.json).sort());
      assert.equal(r.json.options.userVerification, "required");
      assert.deepEqual(r.json.options.hints, ["client-device"]);
      assert.equal(r.json.options.allowCredentials.length, 1);
      assert.deepEqual(r.json.options.allowCredentials[0].transports, ["internal"]);
    }
    // Stable per email (re-querying can't detect the decoy) …
    assert.equal(a.json.options.allowCredentials[0].id, b.json.options.allowCredentials[0].id);
    // … but not a shared constant across emails.
    assert.notEqual(a.json.options.allowCredentials[0].id, c.json.options.allowCredentials[0].id);
    // And never colliding with a real credential id format expectation.
    assert.match(a.json.options.allowCredentials[0].id, /^[A-Za-z0-9_-]+$/);
  });
});

// ── Enrollment options + verify ──────────────────────────────────────────────
describe("passkey enrollment — platform-only contract", () => {
  test("register-options pins platform attachment, required UV, client-device hint", async () => {
    const r = await authed("/api/webauthn/register-options", {});
    assert.equal(r.status, 200);
    const o = r.json.options;
    assert.equal(o.rp.id, "admin.test");
    assert.equal(o.authenticatorSelection.authenticatorAttachment, "platform");
    assert.equal(o.authenticatorSelection.userVerification, "required");
    assert.deepEqual(o.hints, ["client-device"]);
    for (const c of o.excludeCredentials) {
      assert.deepEqual(c.transports, ["internal"]);
    }
    assert.ok(r.json.challengeId);
  });

  test("register-verify rejects a cross-platform attestation (QR-linked phone), single-use challenge", async () => {
    const opts = await authed("/api/webauthn/register-options", {});
    assert.equal(opts.status, 200);

    const attempt = () =>
      authed("/api/webauthn/register-verify", {
        challengeId: opts.json.challengeId,
        attestation: { id: "phony", authenticatorAttachment: "cross-platform", response: {} },
        deviceName: "Someone's phone",
      });

    const first = await attempt();
    assert.equal(first.status, 400);
    assert.match(first.json.error, /built-in authenticator/i);

    // The rejected attempt must have consumed the challenge (no retry oracle).
    const second = await attempt();
    assert.equal(second.status, 400);
    assert.match(second.json.error, /expired/i);
  });
});
