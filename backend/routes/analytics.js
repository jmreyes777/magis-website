const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const authenticateSuperAdmin = require("../middlewares/authenticateSuperAdmin");

const isDev = process.env.NODE_ENV === "development";
const devLog = (...args) => { if (isDev) devLog(...args); };

/**
 * GET /api/analytics/debug
 * Debug endpoint to check messages collection
 */
router.get("/debug", authenticateBranchAdmin, async (req, res) => {
  try {
    devLog("[ANALYTICS DEBUG] Checking messages collection");
    devLog("[ANALYTICS DEBUG] Branch email from auth:", req.branchEmail);
    
    const snapshot = await db.collection("messages").limit(5).get();
    devLog("[ANALYTICS DEBUG] Total messages in collection:", snapshot.size);
    
    const sampleMessages = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    devLog("[ANALYTICS DEBUG] Sample messages:", sampleMessages);
    
    res.json({
      totalMessages: snapshot.size,
      sampleMessages: sampleMessages,
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
    const targetBranchEmail = branchEmail || req.branchEmail;
    
    if (!targetBranchEmail) {
      devLog("[ANALYTICS] No branch email available");
      return res.status(400).json({ error: "Branch email is required" });
    }

    let query = db.collection("messages");
    
    devLog("[ANALYTICS] Starting Firestore query for messages collection");
    
    // Apply date range filter
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      devLog("[ANALYTICS] Applying date range filter:", { start, end });
      query = query
        .where("timestamp", ">=", start)
        .where("timestamp", "<=", end);
    }
    
    // Apply branch filter
    if (targetBranchEmail) {
      devLog("[ANALYTICS] Applying branch filter:", targetBranchEmail);
      query = query.where("branchEmail", "==", targetBranchEmail);
    }

    // Ensure archived messages are included (not filtered out)
    // Firestore doesn't have a "not equal" operator, so we fetch all and filter client-side if needed
    devLog("[ANALYTICS] Query will include both archived and non-archived messages");

    const snapshot = await query.get();
    devLog("[ANALYTICS] Firestore query returned", snapshot.size, "documents");
    
    if (snapshot.size === 0) {
      devLog("[ANALYTICS] No messages found, returning empty data");
      return res.json({
        totalMessages: 0,
        averageDaily: 0,
        volumeByDate: []
      });
    }
    
    const messages = snapshot.docs.map(doc => doc.data());
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
      totalMessages: messages.length,
      averageDaily: averageDaily,
      volumeByDate: volumeData,
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
    
    const targetBranchEmail = branchEmail || req.branchEmail;
    
    if (!targetBranchEmail) {
      return res.status(400).json({ error: "Branch email is required" });
    }

    let query = db.collection("messages");
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      query = query
        .where("timestamp", ">=", start)
        .where("timestamp", "<=", end);
    }
    
    if (targetBranchEmail) {
      query = query.where("branchEmail", "==", targetBranchEmail);
    }

    const snapshot = await query.get();
    const messages = snapshot.docs.map(doc => doc.data());

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
      responseTimeDistribution
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
    
    const targetBranchEmail = branchEmail || req.branchEmail;
    
    if (!targetBranchEmail) {
      return res.status(400).json({ error: "Branch email is required" });
    }

    let query = db.collection("messages");
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      query = query
        .where("timestamp", ">=", start)
        .where("timestamp", "<=", end);
    }
    
    if (targetBranchEmail) {
      query = query.where("branchEmail", "==", targetBranchEmail);
    }

    const snapshot = await query.get();
    const messages = snapshot.docs.map(doc => doc.data());

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
      conversations
    });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching conversation summary:", error.message);
    res.status(500).json({ error: "Failed to fetch conversation summary analytics" });
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

    let query = db.collection("messages");
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      query = query
        .where("timestamp", ">=", start)
        .where("timestamp", "<=", end);
    }

    const snapshot = await query.get();
    const messages = snapshot.docs.map(doc => doc.data());

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

    // Calculate metrics for each branch
    const performanceData = Object.values(branchPerformance).map(branch => ({
      branchEmail: branch.branchEmail,
      messageCount: branch.messageCount,
      uniqueConversations: branch.uniqueGuests.size,
      avgMessagesPerConversation: branch.uniqueGuests.size > 0
        ? Math.round(branch.messageCount / branch.uniqueGuests.size)
        : 0
    })).sort((a, b) => b.messageCount - a.messageCount);

    res.status(200).json({
      totalBranches: performanceData.length,
      totalMessages: messages.length,
      branchPerformance: performanceData
    });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching branch performance:", error.message);
    res.status(500).json({ error: "Failed to fetch branch performance analytics" });
  }
});

module.exports = router;

