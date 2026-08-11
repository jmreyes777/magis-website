// Workstream C: contract tests for the read-only MCP endpoint (/api/mcp).
// Uses the TST5 harness (real app, hermetic env). Firestore-backed tools are
// exercised at the protocol level only — the harness pins FIREBASE_*="" so
// tool handlers that touch Firestore would surface as isError tool results,
// never as crashes. Static tools (get_services_info) are asserted end-to-end.
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");

const { request, stop } = require("./httpHarness");

after(stop);

// Streamable HTTP requires the client to accept both JSON and SSE.
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const rpc = (body) =>
  request("/api/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tst-client", version: "0.0.0" },
  },
};

describe("MCP endpoint — protocol", () => {
  test("initialize handshake returns serverInfo (stateless, no session header required)", async () => {
    const res = await rpc(INIT);
    assert.equal(res.status, 200);
    assert.equal(res.json.result.serverInfo.name, "magis-pawnshop");
    // Stateless mode must NOT mint sessions (nothing to hijack).
    assert.equal(res.headers.get("mcp-session-id"), null);
  });

  test("tools/list exposes exactly the four read-only tools", async () => {
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

  test("GET is rejected with 405 (no SSE streams, POST-only)", async () => {
    const res = await request("/api/mcp", { method: "GET", headers: MCP_HEADERS });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  test("DELETE is rejected with 405 (stateless — no sessions to delete)", async () => {
    const res = await request("/api/mcp", { method: "DELETE", headers: MCP_HEADERS });
    assert.equal(res.status, 405);
  });
});

describe("MCP endpoint — tools", () => {
  test("get_services_info returns the public service facts", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_services_info", arguments: {} },
    });
    assert.equal(res.status, 200);
    const content = res.json.result.content;
    assert.equal(content[0].type, "text");
    const facts = JSON.parse(content[0].text);
    assert.equal(facts.established, 1996);
    assert.match(facts.services[0].url, /magispawnshop\.com\/pawning/);
    // The stale-price guardrail must ship with every answer.
    assert.match(facts.note, /appraisal/i);
  });

  test("list_branches rejects an over-long city argument (zod input validation)", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_branches", arguments: { city: "x".repeat(200) } },
    });
    assert.equal(res.status, 200); // JSON-RPC layer: tool errors are payloads
    // SDK surfaces schema violations as a -32602 error or isError result —
    // either way the call must not succeed silently.
    const failed = !!res.json.error || res.json.result?.isError === true;
    assert.equal(failed, true);
  });

  test("unknown tool name is rejected", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "drop_all_tables", arguments: {} },
    });
    assert.equal(res.status, 200);
    const failed = !!res.json.error || res.json.result?.isError === true;
    assert.equal(failed, true);
  });
});
