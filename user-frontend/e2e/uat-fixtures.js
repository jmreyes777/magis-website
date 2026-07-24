// Guest-side UAT fixtures: richer than the smoke fixtures.js — these mock the
// FULL conversational stack so multi-page guest workflows can run end-to-end:
//   • /api/** answered with real response shapes (guest init/refresh, message
//     send/history, conversation-key, branch-status, contact form)
//   • a fake socket.io server via routeWebSocket (engine.io v4 framing) so the
//     app truly "connects", gets WS acks, and can receive staff replies,
//     typing signals, and live presence flips pushed by the test
//   • Node-side AES-GCM helpers mirroring src/utils/e2eeCrypto.js so tests can
//     decrypt what the page sends and encrypt fake staff replies
// Turnstile/Firebase/analytics are blocked fast — pages must degrade exactly
// as they would during a third-party outage.
const crypto = require("crypto");

const GUEST_ID = "guest-e2e-1";
const SUPPORT_EMAIL = "support@magisgold.com";

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const makeGuestJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ guestId: GUEST_ID, role: "guest", iat: now, exp: now + 30 * 60 }),
    "e2e-fake-signature",
  ].join(".");
};

// ── AES-256-GCM helpers (same wire format as src/utils/e2eeCrypto.js) ───────
const subtle = crypto.webcrypto.subtle;

async function encryptWithKey(keyB64, plaintext) {
  const key = await subtle.importKey(
    "raw", Buffer.from(keyB64, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(plaintext, "utf8"));
  return { ciphertext: Buffer.from(ct).toString("base64"), iv: Buffer.from(iv).toString("base64") };
}

async function decryptWithKey(keyB64, { ciphertext, iv }) {
  const key = await subtle.importKey(
    "raw", Buffer.from(keyB64, "base64"), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") }, key, Buffer.from(ciphertext, "base64"));
  return Buffer.from(pt).toString("utf8");
}

/**
 * Install the API mock. Returns a mutable `state` the test can inspect
 * (recorded calls) and reconfigure mid-test (e.g. flip sendFails off to test
 * recovery). Third-party origins are fulfilled with fast 403s.
 */
async function mockGuestNetwork(page, opts = {}) {
  const state = {
    calls: [], // { method, path, postData }
    branchOnline: opts.branchOnline ?? true,
    initFails: opts.initFails ?? false,
    sendFails: opts.sendFails ?? false,
    convKeyFails: opts.convKeyFails ?? false,
    expireFirstSend: opts.expireFirstSend ?? false,
    wsAckFails: opts.wsAckFails ?? false, // sendMessage acks report failure (F-G2)
    convKeyB64: crypto.randomBytes(32).toString("base64"),
    sendCount: 0,
    savedCount: 0,
    // populated by fakeSocketIO:
    wsConnections: [],
    socketEmits: [],
    pushEvent: () => {},
  };

  await page.route(
    /(googleapis\.com|gstatic\.com|google\.com|firebaseio\.com|cloudflare\.com|facebook|fbcdn|googletagmanager)/,
    (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "blocked by UAT fixture" })
  );

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch { /* form-data or empty */ }
    state.calls.push({ method, path, postData: body });

    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

    if (path === "/api/csrf-token") return json(200, { csrfToken: "e2e-csrf" });

    if (path === "/api/guest/init" && method === "POST") {
      if (state.initFails) return json(500, { error: "internal" });
      return json(200, { guestId: GUEST_ID, token: makeGuestJwt() });
    }
    if (path === "/api/guest/refresh-token" && method === "POST") {
      return json(200, { token: makeGuestJwt() });
    }
    if (path === "/api/guest/force-close" && method === "POST") return json(200, { ok: true });

    if (path.startsWith("/api/branch-status")) {
      return json(200, {
        online: state.branchOnline,
        lastSeen: new Date(Date.now() - 60_000).toISOString(),
      });
    }

    if (path === "/api/messages/conversation-key" && method === "POST") {
      if (state.convKeyFails) return json(500, { error: "kms unavailable" });
      return json(200, { key: state.convKeyB64 });
    }
    if (path.startsWith("/api/messages/history/")) return json(200, { messages: [] });
    if (path.startsWith("/api/messages/mark-seen")) return json(200, { ok: true });

    if (path === "/api/messages/send" && method === "POST") {
      state.sendCount += 1;
      if (state.expireFirstSend && state.sendCount === 1) {
        return json(401, { error: "jwt expired" });
      }
      if (state.sendFails) return json(500, { error: "Message could not be saved." });
      state.savedCount += 1;
      // Echo back what the client sent — including ciphertext when E2EE is on,
      // exactly like the real backend (it stores content opaquely).
      return json(200, {
        savedMessage: {
          id: `srv-${state.savedCount}`,
          content: body.content ?? "",
          timestamp: new Date().toISOString(),
          media: null,
        },
      });
    }

    if (path === "/api/contact" && method === "POST") return json(200, { success: true });

    return json(200, {}); // rum, client-errors, site-config, facebook, ...
  });

  return state;
}

/**
 * Fake socket.io server (engine.io v4 over WebSocket). Ack-replies to every
 * emit-with-ack; records all emits into state.socketEmits; exposes
 * state.pushEvent(event, ...args) so tests can act as the branch/staff side.
 */
async function fakeSocketIO(page, state) {
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    state.wsConnections.push(ws);
    ws.onMessage((raw) => {
      const msg = String(raw);
      if (msg.startsWith("40")) return ws.send('40{"sid":"e2e-nsp-sid"}');
      if (msg === "2") return ws.send("3"); // ping → pong (either direction)
      if (msg === "3") return; // pong
      const m = /^42(\d*)(\[[\s\S]*\])$/.exec(msg);
      if (!m) return;
      let parsed = [];
      try { parsed = JSON.parse(m[2]); } catch { return; }
      const [event, ...args] = parsed;
      state.socketEmits.push({ event, args });
      if (m[1] !== "") {
        // Acknowledge (joinRoom, sendMessage, chatClosed all use acks). The
        // app's sendMessage() resolves only when ack.success is truthy.
        const ack =
          event === "sendMessage" && state.wsAckFails
            ? { success: false, error: "relay unavailable (e2e)" }
            : { success: true, message: { status: "delivered" } };
        ws.send(`43${m[1]}${JSON.stringify([ack])}`);
      }
    });
    // engine.io OPEN packet — client then sends "40" to join the namespace.
    ws.send('0{"sid":"e2e-eio-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    // EIO4: the SERVER initiates heartbeats. Without pings the client's
    // watchdog declares the connection dead after pingInterval+pingTimeout
    // (~45s) and long tests watch the composer disable itself mid-flight.
    const heartbeat = setInterval(() => {
      try { ws.send("2"); } catch { clearInterval(heartbeat); }
    }, 20_000);
    ws.onClose(() => clearInterval(heartbeat));
  });

  state.pushEvent = (event, ...args) => {
    for (const ws of state.wsConnections) {
      try { ws.send(`42${JSON.stringify([event, ...args])}`); } catch { /* closed */ }
    }
  };
  return state;
}

/** Kill the socket transport entirely (connection refused, fast). */
async function deadSocketIO(page) {
  await page.routeWebSocket(/\/socket\.io\//, (ws) => ws.close({ code: 1006, reason: "e2e dead socket" }));
}

/**
 * Pages are served PRERENDERED: real markup, dead event handlers until React
 * hydrates. Clicking too early is a silent no-op (the exact flake this suite
 * kept hitting under load), so every interactive test must gate on hydration.
 * The container key (`__reactContainer$…`) appears when React BOOTS, before
 * components commit — so require the element we're about to use to carry a
 * committed fiber (`__reactFiber$…`).
 */
async function waitForHydration(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return (
        !!el &&
        Object.keys(el).some(
          (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")
        )
      );
    },
    selector,
    { timeout: 30_000 }
  );
}

/** Open the Support chat from /contact-us and wait for the box to render. */
async function openSupportChat(page, expect) {
  await page.goto("/contact-us");
  await waitForHydration(page, "button[aria-label='Start chat with support']");
  await page.getByRole("button", { name: /start chat with support/i }).click();
  await expect(page.locator(".guest-chat-box")).toBeVisible({ timeout: 15_000 });
}

/**
 * Gate for send-actions: the chat is only "really" connected once the app has
 * joined its guest room over the fake socket. Sending before that makes the
 * WS delivery ack fail and marks a REST-persisted message as failed (see
 * UAT-REPORT F-G2) — tests must not trip over that race.
 */
async function waitForSocketReady(state, expect) {
  await expect
    .poll(() => state.socketEmits.some((e) => e.event === "joinRoom"), { timeout: 20_000 })
    .toBe(true);
}

const callsTo = (state, prefix) => state.calls.filter((c) => c.path.startsWith(prefix));

module.exports = {
  GUEST_ID,
  SUPPORT_EMAIL,
  makeGuestJwt,
  encryptWithKey,
  decryptWithKey,
  mockGuestNetwork,
  fakeSocketIO,
  deadSocketIO,
  openSupportChat,
  waitForHydration,
  waitForSocketReady,
  callsTo,
};
