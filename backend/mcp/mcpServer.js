// backend/mcp/mcpServer.js
//
// Workstream C (2026 GEO research): read-only MCP server for AI agents.
// Exposes ONLY data that is already public on www.magispawnshop.com — the
// branch directory (/branches page), the next-auction schedule (homepage),
// live-chat availability (footer indicators), and static service facts
// (llms.txt). Nothing here requires or accepts credentials, and no tool can
// write anything.
//
// Transport: Streamable HTTP in STATELESS mode — a fresh McpServer +
// transport pair per POST, no session state, so it scales horizontally and
// survives restarts exactly like the REST routes. Mounted at /api/mcp by
// server.js behind the shared edge-auth + a dedicated rate limiter.
//
// Security posture (research Part 2 checklist):
//  - read-only tools, no auth surface, no user data (guests/chats NEVER)
//  - inputs validated by zod schemas (the SDK enforces them)
//  - responses come from the same Redis read-through caches as the public
//    REST routes, so an agent hammering /api/mcp cannot amplify Firestore
//    reads beyond what the public site already allows
//  - GET/DELETE answered with 405: no SSE streams, no resumable sessions

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const { db } = require("../utils/firebase");
const { cached, key } = require("../utils/cache");
const { getRedis, ensureRedisConnected } = require("../utils/redis");

const SITE = "https://www.magispawnshop.com";
const PRESENCE_PREFIX = process.env.REDIS_PRESENCE_PREFIX || "branch:online:";
const BRANCHES_TTL = Number(process.env.CACHE_BRANCHES_TTL || 300);
const AUCTION_TTL = Number(process.env.CACHE_SITECONFIG_TTL || 300);

// ---------------------------------------------------------------------------
// Data producers — same cache keys as the REST routes (routes/branches.js,
// routes/siteConfig.js) so MCP and the SPA share one cached copy.
// ---------------------------------------------------------------------------

async function readBranches() {
  return cached(key("branches", "list"), BRANCHES_TTL, async () => {
    const snap = await db.collection("branches").get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  });
}

// Public projection: exactly the fields the /branches page renders, minus the
// branch email (live-chat identity — public pages show it only as a chat
// target, so agents get names/addresses/hours, not a mailing list).
function toPublicBranch(b) {
  const schedule = Array.isArray(b.schedule)
    ? b.schedule.map((d) =>
        d && d.open
          ? { day: d.day, open: true, hours: `${d.openTime}–${d.closeTime}` }
          : { day: d && d.day, open: false }
      )
    : null;
  return {
    name: b.name || null,
    address: b.actualAddress || b.address || null,
    phone: b.phone || null,
    schedule,
    jewelry_display: !!b.hasJewelryDisplay,
    branch_finder_url: `${SITE}/branches`,
  };
}

function toIso(value) {
  if (!value) return null;
  try {
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

async function readAuction() {
  // Identical key + shape to GET /api/site-config/auction (shared cache).
  return cached("cache:siteconfig:auction", AUCTION_TTL, async () => {
    const snap = await db.collection("siteConfig").doc("auction").get();
    if (!snap.exists) return { exists: false };
    const data = snap.data() || {};
    return {
      exists: true,
      nextAuctionAt: toIso(data.nextAuctionAt),
      upcomingDates: Array.isArray(data.upcomingDates)
        ? data.upcomingDates
            .map((e) => ({
              startAt: toIso(e && e.startAt),
              endAt: toIso(e && e.endAt),
              label: (e && e.label) || null,
            }))
            .filter((e) => e.startAt)
        : [],
    };
  });
}

// Live-chat presence: count of branches with an active Redis presence key
// (same source of truth as GET /api/branch-status/all). Fail-soft: if Redis
// is unreachable we say availability is unknown rather than erroring the tool.
async function readLiveChatPresence() {
  try {
    const client = getRedis();
    await ensureRedisConnected(client);
    const keys = [];
    let cursor = "0";
    do {
      const [next, batch] = await client.scan(
        cursor,
        "MATCH",
        `${PRESENCE_PREFIX}*`,
        "COUNT",
        100
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return { known: true, onlineCount: keys.length };
  } catch {
    return { known: false, onlineCount: 0 };
  }
}

// Static service facts — same source-of-truth wording as public/llms.txt and
// the pawn/jewelry pages. Update alongside those (never invent rates here).
const SERVICES_FACTS = {
  business: "Magis Gold & Gems Pawnshop & Jewelry",
  established: 1996,
  regulator: "Bangko Sentral ng Pilipinas (BSP)-registered; AMLA and Data Privacy Act (RA 10173) compliant",
  services: [
    {
      service: "Pawn loans (sangla) on gold jewelry",
      details:
        "Appraised by karat and weight at posted branch rates; free on-the-spot appraisal with no obligation; renew (patubo) or redeem (tubos) within the loan term. Interest from 1%/month at select branches. Requirements: the gold item plus one valid government ID.",
      url: `${SITE}/pawning`,
    },
    {
      service: "Gold jewelry sales (alahas)",
      details:
        "Rings, necklaces, earrings, bracelets; layaway (hulugan) available at select branches.",
      url: `${SITE}/jewelry-sales`,
    },
    {
      service: "Monthly auction (subasta) of unredeemed items",
      details: "Schedule posted on the homepage; use the get_next_auction tool for dates.",
      url: `${SITE}/`,
    },
  ],
  guides: [
    `${SITE}/guides/gold-prices-appraisal`,
    `${SITE}/guides/how-to-pawn`,
    `${SITE}/guides/gold-karat-guide`,
    `${SITE}/guides/pawnshop-interest-rates`,
  ],
  note: "Gold prices and branch rates change; direct users to a free in-branch appraisal or the branch finder for current figures.",
};

// ---------------------------------------------------------------------------
// Server factory — one lightweight instance per request (stateless).
// ---------------------------------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({
    name: "magis-pawnshop",
    version: "1.0.0",
  });

  server.registerTool(
    "list_branches",
    {
      title: "List Magis pawnshop branches",
      description:
        "Directory of all Magis Gold & Gems branches in the Philippines: name, street address, phone number, weekly opening hours, and whether the branch has a jewelry sales display. Public information from the branch finder page.",
      inputSchema: {
        city: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Optional city/area filter, e.g. 'Angeles' or 'Quezon City' (case-insensitive substring match on name and address)"
          ),
      },
    },
    async ({ city }) => {
      const branches = await readBranches();
      let list = branches.map(toPublicBranch);
      if (city) {
        const needle = city.toLowerCase();
        list = list.filter(
          (b) =>
            (b.name || "").toLowerCase().includes(needle) ||
            (b.address || "").toLowerCase().includes(needle)
        );
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ total: list.length, branches: list }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    "get_next_auction",
    {
      title: "Get the next jewelry auction schedule",
      description:
        "Upcoming Magis jewelry auction (subasta) dates for unredeemed items, as posted on the homepage. Returns ISO timestamps.",
      inputSchema: {},
    },
    async () => {
      const auction = await readAuction();
      return {
        content: [{ type: "text", text: JSON.stringify(auction, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_live_chat_availability",
    {
      title: "Check live-chat availability",
      description:
        "How many Magis branches currently have staff online for the free live chat on the branch finder page. Point users to the branch finder to start a chat.",
      inputSchema: {},
    },
    async () => {
      const presence = await readLiveChatPresence();
      const payload = presence.known
        ? {
            branches_online_now: presence.onlineCount,
            chat_url: `${SITE}/branches`,
          }
        : {
            branches_online_now: null,
            note: "Availability is briefly unknown; the branch finder page shows per-branch indicators live.",
            chat_url: `${SITE}/branches`,
          };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_services_info",
    {
      title: "Get pawning, jewelry, and auction service facts",
      description:
        "Factual summary of Magis Gold & Gems services: pawn loans (sangla) on gold jewelry, jewelry sales, monthly auctions, requirements, and guide links. Same facts as the public site.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(SERVICES_FACTS, null, 2) }],
    })
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express handlers (stateless Streamable HTTP)
// ---------------------------------------------------------------------------

async function handleMcpPost(req, res) {
  // New server+transport per request: no sessions to hijack, nothing to leak
  // between callers, safe across multiple instances.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // plain JSON responses (no SSE requirement)
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed:", e.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

// Stateless mode has no sessions to resume or delete.
function handleMcpMethodNotAllowed(_req, res) {
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this endpoint." },
      id: null,
    });
}

module.exports = { handleMcpPost, handleMcpMethodNotAllowed, buildMcpServer };
