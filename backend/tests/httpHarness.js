// TST5: shared HTTP-test harness. Imports the REAL fully-wired app from
// server.js (all middleware, limiters, routes, error handler) and serves it on
// an ephemeral localhost port. Zero test dependencies: node:test + global fetch.
//
// Hermetic by construction — env is pinned BEFORE server.js loads, and dotenv
// never overrides keys that already exist, so a populated local backend.env
// changes nothing:
//   - NODE_ENV=test     → no listen(), no firebase init, no warmup, no pollers
//   - REDIS_URL=""      → in-memory rate-limit stores + no socket.io adapter
//   - FIREBASE_*=""     → any accidental Firestore touch throws (surfaces as a
//                         500 through the error handler) instead of hitting a
//                         real project with local credentials
//   - tight limiter budgets → 429 contracts testable with a handful of requests
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "tst5-http-harness-secret-0123456789abcdef";
process.env.REDIS_URL = "";
process.env.JWT_CLOCK_SKEW_SEC = "0"; // let 1ms-TTL tokens actually expire
process.env.FIREBASE_PROJECT_ID = "";
process.env.FIREBASE_PRIVATE_KEY = "";
process.env.FIREBASE_CLIENT_EMAIL = "";
process.env.FIREBASE_STORAGE_BUCKET = "";
process.env.GUEST_CONTACT_RL_MAX = "1"; // second request in the window → 429
process.env.GUEST_CONTACT_RL_WINDOW_MS = "600000";

const http = require("node:http");

const { app, server } = require("../server.js");

let baseUrl = null;

async function start() {
  if (baseUrl) return baseUrl;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stop() {
  if (!baseUrl) return;
  baseUrl = null;
  // Close socket.io first (it owns engine/websocket uv handles attached to the
  // http server) — leaving them live crashes Node-on-Windows at process exit
  // with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
  const io = app.get("socketio");
  if (io) await new Promise((resolve) => io.close(resolve));
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // The JWT worker pool (spawned via server.js → secretPool) holds MessagePort
  // handles that also race libuv teardown on Windows — terminate it explicitly.
  try { await require("../utils/secretPool").shutdown(); } catch { /* already down */ }
}

// Minimal request helper: returns { status, headers, text, json } with json
// parsed when possible (some endpoints deliberately send empty bodies).
//
// Uses node:http with agent:false instead of global fetch — undici's keep-alive
// pool holds live TCP handles at process exit, which crashes Node-on-Windows
// under --test-force-exit (libuv: "!(handle->flags & UV_HANDLE_CLOSING)").
// agent:false sockets are destroyed as each response completes.
function request(path, options = {}) {
  const { method = "GET", headers = {}, body } = options;
  return start().then(
    (base) =>
      new Promise((resolve, reject) => {
        const req = http.request(base + path, { method, headers, agent: false }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
            const headerBag = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              for (const item of Array.isArray(v) ? v : [v]) headerBag.append(k, item);
            }
            resolve({ status: res.statusCode, headers: headerBag, text, json });
          });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      })
  );
}

module.exports = { app, server, start, stop, request };
