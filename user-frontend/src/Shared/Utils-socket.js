import { io } from "socket.io-client";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "http://localhost:5000";
const HEARTBEAT_INTERVAL = 30000;
const MAX_MISSED_PINGS = 3;
const MAX_RECONNECT_ATTEMPTS = 5;

let reconnectAttempts = 0;
let missedPings = 0;
let heartbeatInterval;
export let isConnecting = false;
let messageListeners = new Set();
let typingListeners = new Set();
let branchStatusListeners = new Set();

let socketInstance = null;

/**
 * ✅ Initialize WebSocket listeners once
 */
const initializeSocketListeners = (socket) => {
  if (socket.hasInitializedListeners) return;
  socket.hasInitializedListeners = true;

  socket.on("receiveMessage", (message) => {
    console.log("[SOCKET] 📩 New message received:", message);
    messageListeners.forEach((listener) => listener(message));
  });

  socket.on("typing", (data) => {
    console.log("[SOCKET] ✍️ Typing event received:", data);
    typingListeners.forEach((listener) => listener(data));
  });

  socket.on("branchStatus", (status) => {
    console.log("[SOCKET] 🔄 Branch status update:", status);
    branchStatusListeners.forEach((listener) => listener(status));
  });

  socket.on("disconnect", async (reason) => {
    console.warn(`[SOCKET] ❌ User socket disconnected. Reason: ${reason}`);

    if (!sessionStorage.getItem("guestId")) {
      console.log("[SOCKET] No active session. Skipping reconnection.");
      return;
    }

    if (reason !== "io client disconnect" && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const retryDelay = Math.min(5000 * reconnectAttempts, 30000);
      console.log(`[SOCKET] 🔄 Attempting reconnection in ${retryDelay / 1000} seconds...`);

      setTimeout(() => {
        if (!socket.connected) {
          reconnectAttempts++;
          console.log(`[SOCKET] 🔄 Reconnection attempt #${reconnectAttempts}`);
          connectSocket(sessionStorage.getItem("guestId"));
        }
      }, retryDelay);
    } else {
      console.error("[SOCKET] ❌ Max reconnection attempts reached. Stopping retries.");
    }
  });
};

/**
 * ✅ Get or create the WebSocket instance
 */
export const getSocketInstance = () => {
  if (!socketInstance) {
    socketInstance = io(`${SOCKET_URL}?role=user`, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: false,
    });
    initializeSocketListeners(socketInstance);
  }
  return socketInstance;
};

const socket = getSocketInstance();

/**
 * ✅ Connect to the WebSocket server
 */
export const connectSocket = async (guestId) => {
  if (socket.connected || isConnecting) {
    console.warn("[SOCKET] Connection attempt skipped (already connected or connecting).");
    return;
  }

  if (!guestId) {
    console.error("[SOCKET] ❌ Cannot connect: Missing guestId.");
    return;
  }

  const token = sessionStorage.getItem("guestToken");
  const branchEmail = sessionStorage.getItem("branchEmail"); // ✅ Must match backend
  const tabId = localStorage.getItem("tabId");
  const sessionTabId = window.name;

  if (!token || !branchEmail || !tabId || !sessionTabId) {
    console.error("[SOCKET] ❌ Missing required socket auth fields:", {
      token,
      branchEmail,
      tabId,
      sessionTabId,
    });
    return;
  }

  // ✅ Inject full socket handshake auth payload
  socket.auth = {
    token,
    guestId,
    branchEmail,
    tabId,
    sessionTabId,
  };

  isConnecting = true;
  console.log(`[SOCKET] 🔄 Connecting socket with guestId: ${guestId}`);
  socket.connect();
  startHeartbeat();

  socket.once("connect", () => {
    console.log(`[SOCKET] ✅ Connection established for guest: ${guestId}`);
    isConnecting = false;
  });

  socket.once("disconnect", (reason) => {
    console.warn(`[SOCKET] 🔌 Disconnected: ${reason}`);
    isConnecting = false;
  });
};


/**
 * ✅ Disconnect from the WebSocket server
 */
export const disconnectSocket = (isChatClosed = false) => {
  if (!socket.connected) {
    console.warn("[SOCKET] Disconnect skipped (socket already disconnected).");
    return;
  }

  console.log("[SOCKET] Preparing to disconnect...");
  socket.disconnect();
  stopHeartbeat();

  reconnectAttempts = 0;
  missedPings = 0;

  sessionStorage.removeItem("guestToken");
  sessionStorage.removeItem("guestId");
  sessionStorage.removeItem("chatOpen");
  console.log("[SOCKET] User session cleared.");
};

/**
 * ✅ Start the heartbeat mechanism
 */
const startHeartbeat = () => {
  if (heartbeatInterval) {
    console.warn("[SOCKET] ⚠️ Heartbeat already running. Skipping restart.");
    return;
  }

  heartbeatInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit("heartbeat");
      console.log("[SOCKET] 💓 Sent heartbeat.");

      socket.once("heartbeat-ack", () => {
        missedPings = 0;
      });
    } else {
      missedPings++;
      console.warn(`[SOCKET] ⚠️ Missed Heartbeats: ${missedPings}/${MAX_MISSED_PINGS}`);

      if (missedPings >= MAX_MISSED_PINGS) {
        console.warn("[SOCKET] ❌ Too many missed heartbeats. Disconnecting...");
        disconnectSocket(sessionStorage.getItem("guestId"), true);
      }
    }
  }, HEARTBEAT_INTERVAL);
};

/**
 * ✅ Stop the heartbeat mechanism
 */
const stopHeartbeat = () => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
};

/**
 * ✅ Handle tab close event
 */
const handleTabClose = () => {
  disconnectSocket();
};
window.removeEventListener("beforeunload", handleTabClose);
window.addEventListener("beforeunload", handleTabClose);
window.addEventListener("unload", handleTabClose);

/**
 * ✅ Listen for branch status updates
 */
export const onBranchStatus = (callback) => {
  branchStatusListeners.add(callback);
};

/**
 * ✅ Emit an event when a message is sent
 */
export const emitMessage = (guestId, message) => {
  try {
    if (socket.connected) {
      const formattedMessage = {
        room: `guest-${guestId}`,
        branchEmail: message.branchEmail,
        content: message.content,
        guestId: message.guestId,
        sender: "guest",
        status: "sent",
        timestamp: new Date().toISOString(),
      };
      socket.emit("sendMessage", formattedMessage);
      console.log(`[SOCKET] Message sent:`, formattedMessage);
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting message:", error.message);
  }
};

/**
 * ✅ Listen for new messages
 */
export const onNewMessage = (callback) => {
  messageListeners.add(callback);
};

/**
 * ✅ Emit an event when a message is seen
 */
export const emitMessageSeen = (guestId, messageId) => {
  try {
    if (socket.connected) {
      socket.emit("markSeen", { room: `guest-${guestId}`, messageId });
      console.log(`[SOCKET] Message seen: guest-${guestId}, message ID: ${messageId}`);
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting message seen event:", error.message);
  }
};

/**
 * ✅ Emit a typing event
 */
export const emitTyping = (guestId, senderId, isTyping) => {
  try {
    if (socket.connected) {
      socket.emit("typing", { room: `guest-${guestId}`, sender: senderId, isTyping });
      console.log(`[SOCKET] Typing event emitted: room=guest-${guestId}, sender=${senderId}, typing=${isTyping}`);
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting typing event:", error.message);
  }
};

export const onTyping = (callback) => {
  typingListeners.add(callback);
};

/**
 * ✅ Emit an event when a chat is closed
 */
export const emitChatClosed = (guestId, branchEmail) => {
  if (!guestId || !branchEmail) {
    console.error("[SOCKET] ❌ Missing guestId or branchEmail in emitChatClosed");
    return;
  }

  if (!socket) {
    console.error("[SOCKET] ❌ Socket instance not initialized");
    return;
  }

  if (!socket.connected) {
    console.warn("[SOCKET] ⚠️ Socket is disconnected. Delaying chatClosed emit...");

    socket.once("connect", () => {
      console.log("[SOCKET] 🔁 Reconnected. Emitting chatClosed for:", guestId);
      socket.emit("chatClosed", { guestId, branchEmail });
    });

    // Reconnect if needed
    if (socket.disconnected) {
      try {
        socket.connect();
      } catch (err) {
        console.error("[SOCKET] ❌ Failed to reconnect socket:", err.message);
      }
    }
    return;
  }

  // ✅ Normal case
  console.log(`[SOCKET] ✅ Emitting chatClosed for guestId: ${guestId}, branchEmail: ${branchEmail}`);
  socket.emit("chatClosed", { guestId, branchEmail });
};


/**
 * ✅ Cleanup all socket listeners to prevent memory leaks
 */
export const cleanupSocketListeners = () => {
  try {
    socket.off("typing");
    socket.off("receiveMessage");
    socket.off("messageSeen");
    socket.off("chatClosed");
    socket.off("branchStatus");
    console.log("[SOCKET] User socket listeners removed");
  } catch (error) {
    console.error("[SOCKET] Error cleaning up listeners:", error.message);
  }
};

export default socket;