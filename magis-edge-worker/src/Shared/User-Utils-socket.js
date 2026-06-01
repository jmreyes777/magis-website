// User-Utils-socket.js
import { io } from "socket.io-client";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "https://localhost:5000";

const conn = navigator.connection || {};
const isSlow = typeof conn.effectiveType === 'string' && conn.effectiveType.includes('2g');

// Double on slow networks
const HEARTBEAT_INTERVAL = isSlow ? 60000 : 30000;
const MAX_MISSED_PINGS = 3;
const MAX_RECONNECT_ATTEMPTS = 5;

let reconnectAttempts = 0;
let missedPings = 0;
let heartbeatInterval = null;
let broadcastInterval = null;
export let isConnecting = false;

// Sets for storing external subscribers (all callbacks here will be invoked when a message is received)
const messageListeners = new Set();
const typingListeners = new Set();
const branchStatusListeners = new Set();
const connectionListeners = new Set(); // For connection status subscribers

function notifyConnectionStatus(online) {
  connectionListeners.forEach((cb) => {
    try { cb(online); } catch {}
  });
}

/**
 * Subscribe to socket & network connect/disconnect events.
 * @param {(online: boolean) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onConnectionStatus(cb) {
  connectionListeners.add(cb);
  return () => connectionListeners.delete(cb);
}

/**
 * Unsubscribe from connection-status events.
 * @param {(online: boolean) => void} cb
 */
export function offConnectionStatus(cb) {
  connectionListeners.delete(cb);
}

/**
 * Let the UI subscribe to net-work connect/disconnect events.
 * callback receives a boolean: true=online, false=offline.
 */

let socketInstance = null;

/**
 * Returns true if the given JWT is expired.
 * Expects a standard JWT string (header.payload.signature).
 */
function isTokenExpired(jwt) {
  if (!jwt) return true;
  try {
    const [, payloadB64] = jwt.split('.');
    const { exp } = JSON.parse(atob(payloadB64));
    // exp is in seconds; Date.now() is ms
    return exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

// Decode the JWT payload
function parseJwt(token) {
  try {
    const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(b).split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
    ).join(''));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Ensure we have a fresh guestToken, refresh if it's expired or within 60s of expiry.
async function ensureValidGuestToken() {
  const token = sessionStorage.getItem('guestToken');
  if (!token) throw new Error("No guest token available");
  const payload = parseJwt(token);
  if (!payload || !payload.exp) return; // unknown shape, let the call handle it
  const expiresAt = payload.exp * 1000;
  // If it's already expired or will in the next minute, refresh:
  if (Date.now() >= expiresAt - 60*1000) {
    console.debug("[GUEST] ⚙️ Token near expiry, refreshing now…");
    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
      { method: "POST", credentials: "include" }
    );
    if (!res.ok) throw new Error("Unable to refresh guest token");
    console.debug("[GUEST] ✅ Guest token refreshed proactively");
  }
}

// -----------------------------------------------------------------------------
// Heartbeat and Broadcast Functions
// -----------------------------------------------------------------------------

const startBroadcastHeartbeat = () => {
  // Clear any existing broadcast interval
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  broadcastInterval = setInterval(() => {
    const guestId = sessionStorage.getItem("guestId");
    const branchEmail = sessionStorage.getItem("branchEmail");
    const tabId = localStorage.getItem("tabId");
    const sessionTabId = window.name;
    const isReady = guestId && branchEmail && tabId && sessionTabId;
    if (!isReady) {
      console.warn("[GUEST] ⚠️ Missing session info for heartbeat");
      return;
    }
    const timestamp = Date.now();
    const sock = getSocketInstance();
    if (sock && sock.connected) {
      sock.emit("heartbeat");
      sock.emit("tabAlive", { tabId, sessionTabId, timestamp });
      sock.emit("broadcastAlive", { tabId, sessionTabId, branchEmail, timestamp });
      console.log("[GUEST] 📡 Emitted heartbeat + presence");
    } else if (!isConnecting) {
      console.warn("[GUEST] 🔁 Disconnected — trying to reconnect via passive heartbeat...");
      connectSocket(guestId);
    }
  }, 5000);
};

const stopBroadcastHeartbeat = () => {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
};

const startHeartbeat = () => {
  const sock = getSocketInstance();
  if (!sock || sock.disconnected) {
    console.warn("[SOCKET] ⚠️ Socket not ready. Skipping heartbeat setup.");
    return;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  heartbeatInterval = setInterval(() => {
    const isSuppressed =
      sock.__suppressDisconnect === true || window.__SENDING_TRANSCRIPT === true;
    if (sock.connected) {
      sock.emit("heartbeat");
      console.log("[SOCKET] 💓 Sent heartbeat.");
      sock.once("heartbeat-ack", () => {
        missedPings = 0;
      });
    } else {
      if (isSuppressed) {
        console.log("[SOCKET] ⏸️ Suppression active — skipping missed ping count.");
        return;
      }
      missedPings++;
      console.warn(`[SOCKET] ⚠️ Missed Heartbeats: ${missedPings}/${MAX_MISSED_PINGS}`);
      if (missedPings >= MAX_MISSED_PINGS) {
        console.warn("[SOCKET] 🔁 Too many missed heartbeats. Triggering reconnect…");
        missedPings = 0;
        isConnecting = false;
        const guestId = sessionStorage.getItem("guestId");
        if (guestId) {
          connectSocket(guestId);
        } else {
          console.error("[SOCKET] ❌ Cannot reconnect — guestId missing");
        }
      }
    }
  }, HEARTBEAT_INTERVAL);
};

const stopHeartbeat = () => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
};

// -----------------------------------------------------------------------------
// Stable Listener Callbacks
// -----------------------------------------------------------------------------

// This handler is attached once and calls all registered callbacks.
const handleReceiveMessage = (message) => {
  const currentGuestId = sessionStorage.getItem("guestId");
  if (process.env.NODE_ENV !== "production") {
    console.debug("[SOCKET] 📩 Incoming message payload:", message);
    console.debug(`[SOCKET] 📩 Current session guestId: ${currentGuestId}`);
    console.debug(`[SOCKET] 📩 Message guestId: ${message.guestId}`);
  }
  if (message.guestId === currentGuestId) {
    // Mark retryable if delivery to admin failed
    if (message.sender === "guest" && message.deliveredToAdmin === false) {
      message.pendingRetry = true;
    }
    console.debug("[SOCKET] ✅ Message guestId matches current session. Notifying listeners...");
    messageListeners.forEach((listener) => listener(message));
  } else {
    console.warn(
      `[SOCKET] ⚠️ Message guestId (${message.guestId}) does NOT match session guestId (${currentGuestId}). Ignoring.`
    );
  }
};

const handleTyping = (data) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[SOCKET] ✍️ Typing:", data);
  }
  typingListeners.forEach((listener) => listener(data));
};

const handleBranchStatus = (status) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[SOCKET] 🔄 Branch status:", status);
  }
  branchStatusListeners.forEach((listener) => listener(status));
};

const handleDisconnect = async (reason) => {
  const guestId = sessionStorage.getItem("guestId");
  const isManualDisconnect = reason === "io client disconnect";
  console.warn(`[SOCKET] ❌ Disconnected: ${reason}`);
  isConnecting = false;
  if (!guestId) {
    console.debug("[SOCKET] No active session, skipping reconnect.");
    return;
  }
  if (!isManualDisconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    const retryDelay = Math.min(5000 * reconnectAttempts, 30000);
    console.info(`[SOCKET] 🔄 Reconnecting in ${retryDelay / 1000}s...`);
    setTimeout(() => {
      const sock = getSocketInstance();
      if (sock && sock.disconnected) {
        reconnectAttempts++;
        console.info(`[SOCKET] 🔄 Retry #${reconnectAttempts}`);
        connectSocket(guestId);
      }
    }, retryDelay);
  } else if (!isManualDisconnect) {
    console.error("[SOCKET] 🚫 Max reconnection attempts reached.");
  }
};


// -----------------------------------------------------------------------------
// Socket Instance and Listener Initialization
// -----------------------------------------------------------------------------

const initializeSocketListeners = (sock) => {
  if (sock.hasInitializedListeners) return;
  sock.hasInitializedListeners = true;
  // Always remove our stable functions first
  sock.off("receiveMessage", handleReceiveMessage);
  sock.off("typing", handleTyping);
  sock.off("branchStatus", handleBranchStatus);
  sock.off("disconnect", handleDisconnect);
  sock.off("connect", notifyConnectionStatus);
  sock.off("disconnect", notifyConnectionStatus);

  sock.on("receiveMessage", handleReceiveMessage);
  sock.on("typing", handleTyping);
  sock.on("branchStatus", handleBranchStatus);

  sock.on("connect", () => {
    reconnectAttempts = 0;
    missedPings = 0;
    isConnecting = false;
    notifyConnectionStatus(true);
    console.debug("[SOCKET] ✅ Guest socket connected — reinitializing");
    if (window.__SENDING_TRANSCRIPT) {
      sock.__suppressDisconnect = true;
      console.debug("[SOCKET] 🔒 Suppression reapplied after reconnect");
    }
    startHeartbeat();
    const currGuestId = sessionStorage.getItem("guestId");
    const guestRoom = `guest-${currGuestId?.replace(/^guest-/, "")}`;
    sock.emit("joinRoom", guestRoom, () => {
      console.log("[SOCKET] 🏠 Joined guest room:", guestRoom);
    });
  });

  sock.on("disconnect", (reason) => {
    isConnecting = false;
    notifyConnectionStatus(false);
    console.warn("[SOCKET] ❌ Disconnected:", reason);
    if (window.__SENDING_TRANSCRIPT) {
      console.warn("[SOCKET] 🚨 Disconnect occurred during transcript operation.");
    }
  });
};

export const getSocketInstance = () => {
  if (!socketInstance) {
    socketInstance = io(`${SOCKET_URL}?role=user`, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: false,
      perMessageDeflate: true
    });
    initializeSocketListeners(socketInstance);
  }
  return socketInstance;
};

const socket = getSocketInstance();

// -----------------------------------------------------------------------------
// Connect, Disconnect, and Tab Close Functions
// -----------------------------------------------------------------------------

export const connectSocket = async (guestIdParam) => {
  // 0️⃣ Proactively refresh the JWT if it's about to expire
  try {
    await ensureValidGuestToken();
  } catch (err) {
    console.warn("[SOCKET] ⚠️ Proactive token refresh failed:", err.message);
    // we'll still try the rest of the connect flow
  }

  // 1️⃣ Load or initialize identifiers
  let guestId = guestIdParam || sessionStorage.getItem("guestId");
  let token   = sessionStorage.getItem("guestToken");
  const branchEmail  = sessionStorage.getItem("branchEmail");
  const tabId        = localStorage.getItem("tabId");
  const sessionTabId = window.name;

  // 2️⃣ Prevent double‐connect
  if (socket.connected || isConnecting) {
    console.warn("[SOCKET] ⏭️ Skipping connect — already connected or connecting");
    return;
  }

  // 3️⃣ If token is missing or expired, refresh or init
  if (!token || isTokenExpired(token)) {
    if (guestId) {
      console.warn("[SOCKET] 🔄 Token expired — refreshing via /api/guest/refresh-token");
      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guestId, branchEmail }),
          }
        );
        const data = await res.json();
        if (res.ok && data.token) {
          token = data.token;
          sessionStorage.setItem("guestToken", token);
          sessionStorage.setItem("guestId", guestId);
          localStorage.setItem("guestId", guestId);
          console.info("[SOCKET] ✅ Token refreshed for", guestId);
        } else {
          console.error("[SOCKET] ❌ Refresh failed:", data.error || "Unknown");
          return;
        }
      } catch (err) {
        console.error("[SOCKET] ❌ Error during token refresh:", err.message);
        return;
      }
    } else {
      console.warn("[SOCKET] 🧩 No guestId — initializing via /api/guest/init");
      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/guest/init`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Guest", branchEmail }),
          }
        );
        const data = await res.json();
        if (res.ok && data.token && data.guestId) {
          token   = data.token;
          guestId = data.guestId;
          sessionStorage.setItem("guestToken", token);
          sessionStorage.setItem("guestId", guestId);
          localStorage.setItem("guestId", guestId);
          sessionStorage.setItem("chatOpen", "true");
          console.info("[SOCKET] ✅ Guest session initialized");
        } else {
          console.error("[SOCKET] ❌ Guest init failed:", data.error || "Unknown");
          return;
        }
      } catch (err) {
        console.error("[SOCKET] ❌ Error during guest init:", err.message);
        return;
      }
    }
  }

  // 4️⃣ Final sanity check
  if (!guestId || !token || !branchEmail || !tabId || !sessionTabId) {
    console.error("[SOCKET] ❌ Missing required auth fields:", {
      guestId, token, branchEmail, tabId, sessionTabId,
    });
    return;
  }

  // 5️⃣ Attach auth and connect
  socket.auth = { token, guestId, branchEmail, tabId, sessionTabId };
  isConnecting = true;
  console.log(`[SOCKET] 🔄 Connecting socket with guestId: ${guestId}`);
  socket.connect();
  startHeartbeat();
  startBroadcastHeartbeat();

  socket.once("connect", () => {
    reconnectAttempts = 0;
    missedPings      = 0;
    isConnecting     = false;
    notifyConnectionStatus(true);

    const rawId     = guestId.replace(/^guest-/, "");
    const guestRoom = `guest-${rawId}`;
    socket.emit("joinRoom", guestRoom);
    console.log(`[SOCKET] 🏠 Joined guest room: ${guestRoom}`);

    initializeSocketListeners(socket);

    const ts = Date.now();
    socket.emit("tabAlive",      { tabId, sessionTabId, timestamp: ts });
    socket.emit("broadcastAlive", { tabId, sessionTabId, branchEmail, timestamp: ts });
    console.log("[SOCKET] 🔌 Guest socket connected — presence rebroadcasted");
  });

  socket.once("disconnect", () => {
    console.warn("[SOCKET] 🔌 Disconnected during connect phase");
    isConnecting = false;
  });

  socket.on("connect_error", (err) => {
    console.error("[SOCKET] ❌ Connection error:", err.message);
    isConnecting = false;
  });
};

export const disconnectSocket = async (shouldClearSession = false, reason = "manual") => {
  console.log("[SOCKET] ⛔ disconnectSocket called. Reason:", reason);
  stopHeartbeat();
  stopBroadcastHeartbeat();
  reconnectAttempts = 0;
  missedPings = 0;
  isConnecting = false;
  const guestId = sessionStorage.getItem("guestId");
  const branchEmail = sessionStorage.getItem("branchEmail");
  if (guestId && branchEmail) {
    await emitChatClosed(guestId, branchEmail);
  }
  if (socket?.connected) {
    socket.disconnect();
  } else {
    console.debug("[SOCKET] 🔌 Socket already disconnected.");
  }
  if (shouldClearSession || reason === "tab-close") {
    sessionStorage.removeItem("guestToken");
    sessionStorage.removeItem("guestId");
    sessionStorage.removeItem("chatOpen");
    console.log("[SOCKET] 🧼 Cleared guest session on disconnect");
  } else {
    console.debug("[SOCKET] Retained guest session on disconnect");
  }
};

const handleTabClose = async () => {
  await disconnectSocket(true, "tab-close");
};

window.removeEventListener("beforeunload", handleTabClose);
window.addEventListener("beforeunload", handleTabClose);
window.addEventListener("pagehide", handleTabClose);

// -----------------------------------------------------------------------------
// Listener Registration and Cleanup
// -----------------------------------------------------------------------------

// Instead of trying to attach inline listeners on every call, we'll use a stable approach.
// Call onNewMessage(callback) to add a new callback to the messageListeners set.
export const onNewMessage = (callback) => {
  if (typeof callback === "function") {
    messageListeners.add(callback);
  }
  const sock = getSocketInstance();
  if (sock && sock.connected && !sock.__messageListenerAttached) {
    sock.__messageListenerAttached = true;
    sock.off("receiveMessage", handleReceiveMessage);
    sock.on("receiveMessage", handleReceiveMessage);
  }
};

export const offNewMessage = (callback) => {
  if (typeof callback === "function") {
    messageListeners.delete(callback);
  }
  if (messageListeners.size === 0 && socket && socket.connected) {
    socket.off("receiveMessage", handleReceiveMessage);
    socket.__messageListenerAttached = false;
    console.log("[SOCKET] 🔌 All message listeners removed");
  }
};

export const offTyping = () => {
  socket.off("typing", handleTyping);
};

export const offBranchStatus = (callback) => {
  if (typeof callback === "function") {
    socket.off("branchStatus", callback);
  }
};

// -----------------------------------------------------------------------------
// Emits and Utility Functions
// -----------------------------------------------------------------------------

const normalizeRoom = (guestId) => {
  return `guest-${guestId.replace(/^guest-/, "")}`;
};

export const emitMessageSeen = (guestId, messageId) => {
  try {
    if (socket.connected) {
      const room = normalizeRoom(guestId);
      socket.emit("markSeen", { room, messageId });
      console.log(`[SOCKET] Message seen: ${room}, message ID: ${messageId}`);
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting message seen event:", error.message);
  }
};

export const sendMessage = (messagePayload) => {
  return new Promise((resolve, reject) => {
    const sock = getSocketInstance();
    if (sock && sock.connected) {
      sock.emit("sendMessage", messagePayload, (ack) => {
        if (ack && ack.success) {
          resolve(ack.message);
        } else {
          reject(ack && ack.error ? ack.error : "Message send failed");
        }
      });
    } else {
      reject("Socket not connected");
    }
  });
};

export const emitTyping = (guestId, senderId, isTyping) => {
  try {
    if (socket.connected) {
      const room = normalizeRoom(guestId);
      socket.emit("typing", { room, sender: senderId, isTyping });
      console.log(`[SOCKET] Typing event emitted: room=${room}, sender=${senderId}, typing=${isTyping}`);
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting typing event:", error.message);
  }
};

export const onTyping = (callback) => {
  if (typeof callback === "function") {
    typingListeners.add(callback);
  }
};

// -----------------------------------------------------------------------------
// Additional Exports for Connection and Branch Status Listeners
// -----------------------------------------------------------------------------

export const onGuestConnectionStatusChange = (callback) => {
  if (typeof callback === "function") {
    connectionListeners.add(callback);
  }
};

export const offGuestConnectionStatusChange = (callback) => {
  if (typeof callback === "function") {
    connectionListeners.delete(callback);
  }
};

export const onBranchStatus = (callback) => {
  if (typeof callback === "function") {
    socket.on("branchStatus", callback);
  }
};

/**
 * Emits a 'chatClosed' event for the given guestId and branchEmail.
 * If the socket is disconnected, attempts a reconnect fallback only if the auth token is still valid.
 *
 * @param {string} guestId
 * @param {string} branchEmail
 */
export async function emitChatClosed(guestId, branchEmail) {
  if (!guestId || !branchEmail) {
    console.error(
      "[SOCKET] ❌ Missing guestId or branchEmail in emitChatClosed"
    );
    return;
  }
  if (!socket) {
    console.error("[SOCKET] ❌ Socket instance not initialized");
    return;
  }

  // 1️⃣ Primary path: emit immediately if connected
  if (socket.connected) {
    console.log(
      `[SOCKET] ✅ Emitting chatClosed for guestId: ${guestId}, branchEmail: ${branchEmail}`
    );
    socket.emit("chatClosed", { guestId, branchEmail });
    return;
  }

  // 2️⃣ Fallback: only attempt reconnect if we still have a valid token
  const token = socket.auth?.token;
  if (!token || isTokenExpired(token)) {
    console.debug(
      "[SOCKET] 🔕 Skipping socket reconnect for chatClosed: no valid auth token"
    );
    return;
  }

  console.info("[SOCKET] 🔄 Reconnecting socket to emit chatClosed…");
  // Return a promise that resolves once we've attempted the fallback
  return new Promise((resolve) => {
    // On successful reconnect, emit the event
    socket.once("connect", () => {
      console.log("[SOCKET] 🔁 Reconnected — emitting chatClosed");
      socket.emit("chatClosed", { guestId, branchEmail });
      resolve();
    });

    try {
      socket.connect();
    } catch (err) {
      console.debug(
        "[SOCKET] ❌ Reconnect attempt failed:",
        err.message
      );
      return resolve();
    }

    // Safety timeout: if still disconnected after 3s, give up
    setTimeout(() => {
      if (!socket.connected) {
        console.debug(
          "[SOCKET] ⚠️ Socket still disconnected after delay. Skipping emit."
        );
      }
      resolve();
    }, 3000);
  });
}

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

// ── Browser offline/online → force socket disconnect/reconnect ──
window.addEventListener("offline", () => {
  console.warn("[NETWORK] ⚠️ Browser offline detected — disconnecting guest socket");
  const sock = getSocketInstance();
  if (sock?.connected) sock.disconnect();
});

window.addEventListener("online", async () => {
  console.info("[NETWORK] ✅ Browser online detected — reconnecting guest socket");
  const guestId = sessionStorage.getItem("guestId");
  if (guestId) {
    try {
      await connectSocket(guestId);
      console.log("[NETWORK] 🔄 Guest socket reconnected after network restore");
    } catch (e) {
      console.error("[NETWORK] ❌ Failed to reconnect guest socket:", e);
    }
  }
});

export default socket;