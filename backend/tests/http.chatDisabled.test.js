// CHAT-PARK: contract tests for the parked public live chat (CHAT_ENABLED).
// Flips the switch to "false" for the whole file — the harness pins "true" so
// the rest of the suite keeps exercising the real chat routes.
//
// Proves, with the REAL wired app (no Firestore, no Redis):
//   - every /api/guest/* route and the guest side of /api/messages/* answer
//     503 { code: "CHAT_DISABLED" } before auth (no token needed to see it)
//   - staff/admin message routes are NOT gated
//   - /api/branch-status* answers 200 "everyone offline" without a DB read
//   - POST /api/contact (the contact form — not chat) is unaffected
//   - the MCP get_live_chat_availability tool reports unavailable, tools/list
//     still exposes four tools
//   - guest Socket.IO handshakes are refused with ChatDisabled
//   - flipping the env back to "true" re-opens everything (per-call env read)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const { request, start, stop } = require("./httpHarness");
const { signJWT } = require("../utils/secretPool");
const { isChatEnabled } = require("../utils/chatFeature");

before(() => {
  process.env.CHAT_ENABLED = "false";
});
after(async () => {
  process.env.CHAT_ENABLED = "true"; // courtesy — this file owns its process anyway
  await stop();
});

// ── socket.io handshake probe (engine.io v4 over raw WebSocket) ──────────────
// Connects, waits for the engine.io OPEN packet ("0{...}"), sends the socket.io
// CONNECT packet ("40" + auth payload), and resolves with the first "4x"
// packet the server answers — "40{...}" on success, "44{...}" on refusal.
function probeGuestHandshake(token) {
  return start().then(
    (base) =>
      new Promise((resolve) => {
        const wsUrl =
          base.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket";
        const ws = new WebSocket(wsUrl);
        const finish = (value) => {
          clearTimeout(timer);
          try { ws.close(); } catch { /* already closed */ }
          resolve(value);
        };
        const timer = setTimeout(() => finish({ timeout: true }), 10_000);
        ws.on("message", (raw) => {
          const msg = String(raw);
          if (msg.startsWith("0")) {
            ws.send(
              "40" +
                JSON.stringify({
                  token,
                  tabId: "t1",
                  sessionTabId: "s1",
                  guestId: "guest-park-1",
                  branchEmail: "b@x.com",
                })
            );
            return;
          }
          if (msg.startsWith("4")) finish(msg);
        });
        ws.on("error", (e) => finish({ error: e.message }));
      })
  );
}

const guestToken = () =>
  signJWT(
    { guestId: "guest-park-1", email: "b@x.com", role: "user", fallback: true },
    { expiresIn: "5m" }
  );

describe("isChatEnabled() — env parsing", () => {
  const cases = [
    [undefined, false],
    ["", false],
    ["false", false],
    ["0", false],
    ["yes", false],
    ["true", true],
    ["TRUE", true],
    [" true ", true],
  ];
  for (const [value, expected] of cases) {
    test(`CHAT_ENABLED=${JSON.stringify(value)} → ${expected}`, () => {
      const prev = process.env.CHAT_ENABLED;
      try {
        if (value === undefined) delete process.env.CHAT_ENABLED;
        else process.env.CHAT_ENABLED = value;
        assert.equal(isChatEnabled(), expected);
      } finally {
        process.env.CHAT_ENABLED = prev;
      }
    });
  }
});

describe("guest chat surface — 503 CHAT_DISABLED before auth", () => {
  const gated = [
    ["POST", "/api/guest/init"],
    ["POST", "/api/guest/refresh-token"],
    ["POST", "/api/guest/force-close"],
    ["POST", "/api/guest/csat"],
    ["POST", "/api/guest/contact"],
    ["POST", "/api/messages/start"],
    ["POST", "/api/messages/send"],
    ["POST", "/api/messages/conversation-key"],
    ["GET", "/api/messages/media/x"],
    ["PATCH", "/api/messages/mark-seen-by-guest/x"],
  ];
  for (const [method, path] of gated) {
    test(`${method} ${path} → 503 CHAT_DISABLED, no-store`, async () => {
      const res = await request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({}),
      });
      assert.equal(res.status, 503, `${method} ${path} → ${res.status}`);
      assert.equal(res.json?.code, "CHAT_DISABLED");
      assert.match(res.headers.get("cache-control") || "", /no-store/);
    });
  }

  test("staff routes are NOT gated (history + reply → 401 without a token)", async () => {
    for (const [method, path] of [
      ["GET", "/api/messages/history/g1"],
      ["POST", "/api/messages/reply"],
    ]) {
      const res = await request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ guestId: "g1", content: "hi" }),
      });
      assert.ok([401, 403].includes(res.status), `${method} ${path} → ${res.status} (must not be 503)`);
      assert.notEqual(res.json?.code, "CHAT_DISABLED");
    }
  });

  test("POST /api/contact (contact form — not chat) is unaffected", async () => {
    const res = await request("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 503);
    assert.notEqual(res.json?.code, "CHAT_DISABLED");
  });
});

describe("branch presence — 200 offline, no DB read", () => {
  test("GET /api/branch-status/all → { statuses: {}, chatEnabled: false }", async () => {
    const res = await request("/api/branch-status/all");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json?.statuses, {});
    assert.equal(res.json?.chatEnabled, false);
  });

  test("GET /api/branch-status?branchEmail → online:false", async () => {
    const res = await request("/api/branch-status?branchEmail=a@b.co");
    assert.equal(res.status, 200);
    assert.equal(res.json?.online, false);
    assert.equal(res.json?.chatEnabled, false);
  });
});

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const rpc = (body) =>
  request("/api/mcp", { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });

describe("MCP — parked chat reported, tools still listed", () => {
  test("get_live_chat_availability → live_chat_available:false", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_live_chat_availability", arguments: {} },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.json.result.content[0].text);
    assert.equal(payload.live_chat_available, false);
    assert.equal(payload.branches_online_now, 0);
  });

  test("tools/list still exposes exactly the four read-only tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(res.status, 200);
    const names = res.json.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_live_chat_availability",
      "get_next_auction",
      "get_services_info",
      "list_branches",
    ]);
  });
});

describe("socket gate — guest handshakes refused", () => {
  test("guest connect packet is answered 44 ChatDisabled", async () => {
    const token = await guestToken();
    const reply = await probeGuestHandshake(token);
    assert.equal(typeof reply, "string", `expected a packet, got ${JSON.stringify(reply)}`);
    assert.ok(reply.startsWith("44"), `expected a connect_error packet, got ${reply}`);
    const err = JSON.parse(reply.slice(2));
    assert.equal(err.message, "ChatDisabled");
  });
});

describe("flip back on — the gate opens without a restart", () => {
  test("CHAT_ENABLED=true → guest init validates (400) and handshake accepted", async () => {
    process.env.CHAT_ENABLED = "true";
    try {
      const res = await request("/api/guest/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400, `expected validation 400, got ${res.status}`);

      const token = await guestToken();
      const reply = await probeGuestHandshake(token);
      assert.equal(typeof reply, "string", `expected a packet, got ${JSON.stringify(reply)}`);
      if (reply.startsWith("44")) {
        assert.notEqual(JSON.parse(reply.slice(2)).message, "ChatDisabled");
      } else {
        assert.ok(reply.startsWith("40"), `expected connect/ack packet, got ${reply}`);
      }
    } finally {
      process.env.CHAT_ENABLED = "false";
    }
  });
});
