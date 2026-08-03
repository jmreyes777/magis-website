const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const authenticateSuperAdmin = require("../middlewares/authenticateSuperAdmin");
const { recordAuditEvent, auditContextFromReq, ACTIONS } = require("../utils/auditLog");

const isDev = process.env.NODE_ENV === "development";
const devLog = (...args) => { if (isDev) console.log(...args); };

// ── PERF2-4: bounded, type-correct analytics queries ───────────────────────
// Messages persist `timestamp` as an ISO-8601 string (new Date().toISOString()),
// which sorts lexicographically === chronologically. The previous filters
// compared against Date objects, which by Firestore type-ordering matched NO
// string-typed docs (so these endpoints silently returned nothing). We now
// (a) compare against ISO strings, (b) ALWAYS bound the window (default lookback
// when no range is supplied), and (c) hard-cap the document scan while reporting
// the accurate match total via a count() aggregation (no doc transfer). The
// (branchEmail, timestamp) composite index serves the branch-scoped variant.
const ANALYTICS_MAX_DOCS = Math.max(parseInt(process.env.ANALYTICS_MAX_DOCS, 10) || 20000, 1);
const ANALYTICS_DEFAULT_DAYS = Math.max(parseInt(process.env.ANALYTICS_DEFAULT_DAYS, 10) || 90, 1);

function toIsoBound(value, endOfDay = false) {
  if (value == null || value === "") return null;
  // The dashboard sends date-only strings (YYYY-MM-DD), parsed as UTC midnight.
  // For an inclusive upper bound, extend a date-only end to the end of that day
  // so the final day's messages are included.
  if (endOfDay && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const dt = new Date(`${value}T23:59:59.999Z`);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

// Build a time-bounded, branch-scoped messages query. Always bounded: if either
// bound is missing/invalid it falls back to the last ANALYTICS_DEFAULT_DAYS.
// Branch scoping is unchanged (equality applied only when an email is given).
function buildBoundedMessagesQuery({ branchEmail, startDate, endDate } = {}) {
  let startIso = toIsoBound(startDate);
  let endIso = toIsoBound(endDate, true);
  if (!startIso || !endIso) {
    const endMs = endIso ? new Date(endIso).getTime() : Date.now();
    const startMs = startIso
      ? new Date(startIso).getTime()
      : endMs - ANALYTICS_DEFAULT_DAYS * 86400000;
    startIso = startIso || new Date(startMs).toISOString();
    endIso = endIso || new Date(endMs).toISOString();
  }
  let q = db
    .collection("messages")
    .where("timestamp", ">=", startIso)
    .where("timestamp", "<=", endIso);
  if (branchEmail) q = q.where("branchEmail", "==", branchEmail);
  return { query: q, startIso, endIso };
}

// Execute a bounded query: accurate match count via count() (no doc transfer)
// plus a capped, timestamp-ordered slice of docs for in-Node aggregation, and a
// `truncated` flag set when the scan hit ANALYTICS_MAX_DOCS.
async function runBoundedAnalyticsQuery(boundedQuery) {
  const ordered = boundedQuery.orderBy("timestamp", "asc");
  const [countSnap, docsSnap] = await Promise.all([
    ordered.count().get(),
    ordered.limit(ANALYTICS_MAX_DOCS).get(),
  ]);
  const total = countSnap.data().count;
  const messages = docsSnap.docs.map((d) => d.data());
  return { total, messages, truncated: total > messages.length };
}

/**
 * GET /api/analytics/debug
 * Debug endpoint to check messages collection
 */
router.get("/debug", authenticateBranchAdmin, async (req, res) => {
  try {
    devLog("[ANALYTICS DEBUG] Checking messages collection");
    devLog("[ANALYTICS DEBUG] Branch email from auth:", req.branchEmail);
    
    const snapshot = await db.collection("messages").where("branchEmail", "==", req.branchEmail).limit(5).get();
    devLog("[ANALYTICS DEBUG] Total messages in collection:", snapshot.size);
    
    const sampleMessages = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    devLog("[ANALYTICS DEBUG] Sample messages:", sampleMessages);
    
    res.json({
      totalMessages: snapshot.size,
      sampleMessages: isDev ? sampleMessages : undefined,
      branchEmail: req.branchEmail
    });
  } catch (err) {
    console.error("[ANALYTICS DEBUG] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/analytics/message-volume
 * Get message volume analytics over time
 * Query params: startDate, endDate, branchEmail (optional)
 */
router.get("/message-volume", authenticateBranchAdmin, async (req, res) => {
  try {
    const { startDate, endDate, branchEmail } = req.query;
    const decoded = req.user || req.decoded; // From auth middleware
    
    devLog("[ANALYTICS] Message volume request:", { startDate, endDate, branchEmail, branchEmailFromAuth: req.branchEmail });
    
    // Branch admins can only see their own branch data
    const targetBranchEmail = req.branchEmail;
    
    if (!targetBranchEmail) {
      devLog("[ANALYTICS] No branch email available");
      return res.status(400).json({ error: "Branch email is required" });
    }

    const { query: boundedQuery, startIso, endIso } = buildBoundedMessagesQuery({
      branchEmail: targetBranchEmail,
      startDate,
      endDate,
    });
    const { total, messages, truncated } = await runBoundedAnalyticsQuery(boundedQuery);

    if (total === 0) {
      return res.json({
        totalMessages: 0,
        averageDaily: 0,
        volumeByDate: [],
        window: { start: startIso, end: endIso },
        truncated: false,
      });
    }
    devLog("[ANALYTICS] Sample message data:", messages[0]);

    // Group messages by date
    const groupedByDate = {};
    messages.forEach(msg => {
      if (msg.timestamp) {
        const date = new Date(msg.timestamp).toISOString().split('T')[0];
        groupedByDate[date] = (groupedByDate[date] || 0) + 1;
      }
    });

    // Convert to array format for charts
    const volumeData = Object.entries(groupedByDate).map(([date, count]) => ({
      date,
      count
    })).sort((a, b) => new Date(a.date) - new Date(b.date));

    const averageDaily = volumeData.length > 0 
      ? Math.round(messages.length / volumeData.length) 
      : 0;

    res.status(200).json({
      totalMessages: total,
      averageDaily: averageDaily,
      volumeByDate: volumeData,
      window: { start: startIso, end: endIso },
      truncated,
    });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching message volume:", error.message);
    res.status(500).json({ error: "Failed to fetch message volume analytics" });
  }
});

/**
 * GET /api/analytics/response-time
 * Get response time analytics
 * Query params: startDate, endDate, branchEmail (optional)
 */
router.get("/response-time", authenticateBranchAdmin, async (req, res) => {
  try {
    const { startDate, endDate, branchEmail } = req.query;
    const decoded = req.user || req.decoded;
    
    devLog("[ANALYTICS] Response time request");
    
    const targetBranchEmail = req.branchEmail;
    
    if (!targetBranchEmail) {
      return res.status(400).json({ error: "Branch email is required" });
    }

    const { query: boundedQuery, startIso, endIso } = buildBoundedMessagesQuery({
      branchEmail: targetBranchEmail,
      startDate,
      endDate,
    });
    const { messages, truncated } = await runBoundedAnalyticsQuery(boundedQuery);

    if (messages.length === 0) {
      return res.json({
        averageResponseTime: 0,
        medianResponseTime: 0,
        totalConversations: 0,
        responseTimeDistribution: {
          under5: 0,
          under15: 0,
          under30: 0,
          over30: 0
        }
      });
    }

    // Calculate response times
    const guestConversations = {};
    messages.forEach(msg => {
      const guestId = msg.guestId;
      if (!guestConversations[guestId]) {
        guestConversations[guestId] = {
          guestId,
          guestName: msg.guestName,
          messages: []
        };
      }
      guestConversations[guestId].messages.push(msg);
    });

    const responseTimes = [];
    Object.values(guestConversations).forEach(conversation => {
      const sortedMessages = conversation.messages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );
      
      for (let i = 1; i < sortedMessages.length; i++) {
        const currentMsg = sortedMessages[i];
        const prevMsg = sortedMessages[i - 1];
        
        if (currentMsg.sender === 'admin' && prevMsg.sender === 'guest') {
          const responseTime = (new Date(currentMsg.timestamp) - new Date(prevMsg.timestamp)) / (1000 * 60);
          responseTimes.push(responseTime);
        }
      }
    });

    const avgResponseTime = responseTimes.length > 0 
      ? Math.round(responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length)
      : 0;
    
    const sortedResponseTimes = responseTimes.sort((a, b) => a - b);
    const medianResponseTime = sortedResponseTimes.length > 0
      ? Math.round(sortedResponseTimes[Math.floor(sortedResponseTimes.length / 2)])
      : 0;

    const responseTimeDistribution = {
      under5: responseTimes.filter(t => t < 5).length,
      under15: responseTimes.filter(t => t >= 5 && t < 15).length,
      under30: responseTimes.filter(t => t >= 15 && t < 30).length,
      over30: responseTimes.filter(t => t >= 30).length
    };

    res.json({
      averageResponseTime: avgResponseTime,
      medianResponseTime: medianResponseTime,
      totalConversations: Object.keys(guestConversations).length,
      responseTimeDistribution,
      window: { start: startIso, end: endIso },
      truncated,
    });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching response time:", error.message);
    res.status(500).json({ error: "Failed to fetch response time analytics" });
  }
});

/**
 * GET /api/analytics/conversation-summary
 * Get conversation summary analytics
 * Query params: startDate, endDate, branchEmail (optional)
 */
router.get("/conversation-summary", authenticateBranchAdmin, async (req, res) => {
  try {
    const { startDate, endDate, branchEmail } = req.query;
    const decoded = req.user || req.decoded;
    
    devLog("[ANALYTICS] Conversation summary request");
    
    const targetBranchEmail = req.branchEmail;
    
    if (!targetBranchEmail) {
      return res.status(400).json({ error: "Branch email is required" });
    }
// DPA access logging: an admin viewed conversation analytics (which expose
    // guest conversation metadata) for this branch (best-effort, non-blocking).
    recordAuditEvent({
      category: "access",
      action: ACTIONS.ACCESS_ANALYTICS_VIEWED,
      severity: "info",
      actor: { type: "branchadmin", email: targetBranchEmail, branchEmail: targetBranchEmail },
      branchEmail: targetBranchEmail,
      context: auditContextFromReq(req),
      meta: { view: "conversation-summary" },
    });

    
    const { query: boundedQuery, startIso, endIso } = buildBoundedMessagesQuery({
      branchEmail: targetBranchEmail,
      startDate,
      endDate,
    });
    const { messages, truncated } = await runBoundedAnalyticsQuery(boundedQuery);

    if (messages.length === 0) {
      return res.json({
        totalConversations: 0,
        avgMessagesPerConversation: 0,
        avgConversationDuration: 0,
        conversationsWithMedia: 0,
        conversations: []
      });
    }

    // Group by guest
    const guestConversations = {};
    messages.forEach(msg => {
      const guestId = msg.guestId;
      if (!guestConversations[guestId]) {
        guestConversations[guestId] = {
          guestId,
          guestName: msg.guestName,
          messageCount: 0,
          firstMessage: msg.timestamp,
          lastMessage: msg.timestamp,
          hasMedia: false
        };
      }
      guestConversations[guestId].messageCount++;
      
      if (msg.timestamp) {
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime < new Date(guestConversations[guestId].firstMessage).getTime()) {
          guestConversations[guestId].firstMessage = msg.timestamp;
        }
        if (msgTime > new Date(guestConversations[guestId].lastMessage).getTime()) {
          guestConversations[guestId].lastMessage = msg.timestamp;
        }
      }
      
      if (msg.media) {
        guestConversations[guestId].hasMedia = true;
      }
    });

    const conversations = Object.values(guestConversations).map(conv => {
      const duration = conv.lastMessage && conv.firstMessage
        ? Math.round((new Date(conv.lastMessage) - new Date(conv.firstMessage)) / (1000 * 60))
        : 0;
      return {
        guestName: conv.guestName || 'Unknown',
        messageCount: conv.messageCount,
        duration: duration,
        hasMedia: conv.hasMedia
      };
    });

    const totalConversations = conversations.length;
    const avgMessagesPerConversation = totalConversations > 0
      ? Math.round(messages.length / totalConversations)
      : 0;
    const avgConversationDuration = totalConversations > 0
      ? Math.round(conversations.reduce((sum, c) => sum + c.duration, 0) / totalConversations)
      : 0;
    const conversationsWithMedia = conversations.filter(c => c.hasMedia).length;

    res.json({
      totalConversations,
      avgMessagesPerConversation,
      avgConversationDuration,
      conversationsWithMedia,
      conversations,
      window: { start: startIso, end: endIso },
      truncated,
    });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching conversation summary:", error.message);
    res.status(500).json({ error: "Failed to fetch conversation summary analytics" });
  }
});

// ── CHATUX2: CSAT aggregation ────────────────────────────────────────────────────────
// Ratings are tiny (one doc per guest+branch+day, TTL-bounded), so both
// variants stay within single-field/equality queries — no new composite
// index required:
//   - branch-scoped: equality on branchEmail, date-filtered in memory
//   - global:        range on `at` only (ISO strings sort chronologically)
const CSAT_MAX_DOCS = Math.max(parseInt(process.env.CSAT_MAX_DOCS, 10) || 20000, 1);

// Same windowing rules as buildBoundedMessagesQuery, without the query.
function resolveAnalyticsWindow(startDate, endDate) {
  let startIso = toIsoBound(startDate);
  let endIso = toIsoBound(endDate, true);
  if (!startIso || !endIso) {
    const endMs = endIso ? new Date(endIso).getTime() : Date.now();
    const startMs = startIso
      ? new Date(startIso).getTime()
      : endMs - ANALYTICS_DEFAULT_DAYS * 86400000;
    startIso = startIso || new Date(startMs).toISOString();
    endIso = endIso || new Date(endMs).toISOString();
  }
  return { startIso, endIso };
}

// Fetch ratings in a window and group per branch.
// Returns Map<branchEmail, { count, avg, distribution: {1..5} }>.
async function fetchCsatByBranch({ branchEmail, startIso, endIso }) {
  let q = db.collection("csatRatings");
  if (branchEmail) {
    q = q.where("branchEmail", "==", branchEmail);
  } else {
    q = q.where("at", ">=", startIso).where("at", "<=", endIso);
  }
  const snap = await q.limit(CSAT_MAX_DOCS).get();

  const byBranch = new Map();
  snap.forEach((doc) => {
    const r = doc.data() || {};
    // Branch-scoped variant filters the window here instead of in the query.
    if (branchEmail && (r.at < startIso || r.at > endIso)) return;
    const rating = Number(r.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;

    const key = r.branchEmail || "unknown";
    if (!byBranch.has(key)) {
      byBranch.set(key, { count: 0, sum: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    }
    const s = byBranch.get(key);
    s.count += 1;
    s.sum += rating;
    s.distribution[rating] += 1;
  });

  for (const s of byBranch.values()) {
    s.avg = s.count > 0 ? Math.round((s.sum / s.count) * 10) / 10 : 0;
    delete s.sum;
  }
  return byBranch;
}

/**
 * GET /api/analytics/csat-summary
 * The authenticated branch's own post-chat satisfaction ratings (CHATUX2).
 * Query params: startDate, endDate (same windowing as the other endpoints).
 * Aggregates only — no guest identifiers leave the server.
 */
router.get("/csat-summary", authenticateBranchAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const { startIso, endIso } = resolveAnalyticsWindow(startDate, endDate);
    const byBranch = await fetchCsatByBranch({
      branchEmail: req.branchEmail,
      startIso,
      endIso,
    });
    const stats = byBranch.get(req.branchEmail) || {
      count: 0,
      avg: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    };
    return res.json({ ...stats, window: { start: startIso, end: endIso } });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching CSAT summary:", error.message);
    return res.status(500).json({ error: "Failed to fetch CSAT analytics" });
  }
});

/**
 * GET /api/analytics/branch-performance
 * Get branch performance comparison (superadmin only)
 * Query params: startDate, endDate
 */
router.get("/branch-performance", authenticateSuperAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const decoded = req.user || req.decoded;

    const { query: boundedQuery, startIso, endIso } = buildBoundedMessagesQuery({
      startDate,
      endDate,
    });
    const { total, messages, truncated } = await runBoundedAnalyticsQuery(boundedQuery);

    // Group by branch
    const branchPerformance = {};
    messages.forEach(msg => {
      const branchEmail = msg.branchEmail;
      if (!branchPerformance[branchEmail]) {
        branchPerformance[branchEmail] = {
          branchEmail,
          messageCount: 0,
          uniqueGuests: new Set(),
          messages: []
        };
      }
      branchPerformance[branchEmail].messageCount++;
      branchPerformance[branchEmail].uniqueGuests.add(msg.guestId);
      branchPerformance[branchEmail].messages.push(msg);
    });

    // CHATUX2: satisfaction per branch for the same window — avg is only
    // meaningful alongside its sample size, so both are returned and the UI
    // is expected to show `avg ★ (n)`, never a bare average.
    let csatByBranch = new Map();
    try {
      csatByBranch = await fetchCsatByBranch({ startIso, endIso });
    } catch (e) {
      console.warn("[ANALYTICS] CSAT merge skipped:", e.message);
    }

    // Calculate metrics for each branch
    const performanceData = Object.values(branchPerformance).map(branch => ({
      branchEmail: branch.branchEmail,
      messageCount: branch.messageCount,
      uniqueConversations: branch.uniqueGuests.size,
      avgMessagesPerConversation: branch.uniqueGuests.size > 0
        ? Math.round(branch.messageCount / branch.uniqueGuests.size)
        : 0,
      csatAvg: csatByBranch.get(branch.branchEmail)?.avg ?? null,
      csatCount: csatByBranch.get(branch.branchEmail)?.count ?? 0
    })).sort((a, b) => b.messageCount - a.messageCount);

    res.status(200).json({
      totalBranches: performanceData.length,
      totalMessages: total,
      branchPerformance: performanceData,
      window: { start: startIso, end: endIso },
      truncated,
    });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching branch performance:", error.message);
    res.status(500).json({ error: "Failed to fetch branch performance analytics" });
  }
});

module.exports = router;

