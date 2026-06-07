// User-Utils-socket.js
import { io } from "socket.io-client";
import { getTurnstileToken } from "./turnstile";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "https://localhost:5000";

const conn = navigator.connection || {};
const isSlow = typeof conn.effectiveType === 'string' && conn.effectiveType.includes('2g');
const API_URL = process.env.REACT_APP_API_URL || "";

// Constants for refresh intervals
const PERIODIC_REFRESH_INTERVAL_MS = 5 * 60 * 1000;  // every 5 minutes
const EXPIRY_THRESHOLD_MS        = 60 * 1000;       // 1 minute before expiry

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

/**
 * Fetches a fresh CSRF token from the server.
 * This endpoint must be unprotected (GET) so we can bootstrap CSRF protection.
 *
 * @returns {Promise<string>} The new CSRF token
 * @throws If the fetch fails or the response is malformed
 */
async function fetchCsrfToken() {
  // 1️⃣ Fire a simple GET (no CSRF required to get the CSRF token)
  const res = await fetch(`${API_URL}/api/csrf-token`, {
    method: "GET",
    credentials: "include" // include the HTTP‐only cookie that carries the CSRF secret
  });

  // 2️⃣ Check for network/server errors
  if (!res.ok) {
    throw new Error(`CSRF fetch failed: ${res.status}`);
  }

  // 3️⃣ Parse and validate the response
  const { csrfToken } = await res.json();
  if (!csrfToken) {
    throw new Error("No CSRF token in response");
  }

  // 4️⃣ Cache it globally for subsequent calls
  window.__CSRF_TOKEN__ = csrfToken;

  // 5️⃣ Debug/log so you can see it in your console when it arrives
  console.debug(`[GUEST] 🔐 CSRF token fetched: ${csrfToken.slice(0, 8)}…`);

  return csrfToken;
}

/**
 * Ensures the guest JWT is fresh:
 *  • refreshes if it’s been more than 5 minutes since the last refresh
 *  • or if it’s within 1 minute of expiring.
 */
async function ensureValidGuestToken() {
  const guestId     = sessionStorage.getItem("guestId");
  const branchEmail = sessionStorage.getItem("branchEmail");
  if (!guestId || !branchEmail) {
    throw new Error("Missing guestId or branchEmail for token refresh");
  }

  const token = sessionStorage.getItem("guestToken");
  if (!token) {
    throw new Error("No guest token available");
  }

  const { exp } = parseJwt(token) || {};
  if (!exp) {
    // malformed token, bail out
    return;
  }

  const now   = Date.now();
  const expMs = exp * 1000;

  // 1) If already expired, fail
  if (now >= expMs) {
    throw new Error("Guest token expired");
  }

  // 2) Determine if we need to refresh
  const lastRefresh = parseInt(sessionStorage.getItem("guestLastRefresh") || "0", 10);
  const needsPeriodic = now - lastRefresh >= PERIODIC_REFRESH_INTERVAL_MS;
  const needsExpiry   = now >= expMs - EXPIRY_THRESHOLD_MS;

  if (needsPeriodic || needsExpiry) {
    // Optional CSRF fetch
    if (!window.__CSRF_TOKEN__) {
      await fetchCsrfToken();
    }

    console.log(
      `[GUEST] ⚙️ Refreshing token (periodic=${needsPeriodic}, expiryThreshold=${needsExpiry}) at ${new Date().toISOString()}`
    );

    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
      {
        method:       "POST",
        credentials:  "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": window.__CSRF_TOKEN__,
          // P1-4: prior token as proof (in case the cross-site cookie is blocked).
          "Authorization": `Bearer ${sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken") || ""}`,
        },
        body: JSON.stringify({ guestId, branchEmail }),
      }
    );
    if (!res.ok) {
      throw new Error("Unable to refresh guest token");
    }

    const { token: newToken } = await res.json();
    // 3) Persist the new token and timestamp
    sessionStorage.setItem("guestToken", newToken);
    sessionStorage.setItem("guestLastRefresh", now.toString());

    // 4) Update socket auth so future emits use the fresh token
    if (socket?.auth) {
      socket.auth.token = newToken;
    }

    console.log(
      `[GUEST] ✅ Guest token refreshed successfully at ${new Date().toISOString()}`
    );
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
  broadcastInterval = setInterval(async () => {

   // ► run refresh check every beat
   try {
     await ensureValidGuestToken();
   } catch (err) {
     // expired or other error; the logs inside ensureValidGuestToken will tell you why
     console.debug("[GUEST] 🔄 Heartbeat refresh check:", err.message);
   }
    
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

  // ── Admin has seen a guest message ───────────────────────────
  sock.on("messageSeen", (message) => {
    console.debug("[SOCKET] ✅ Admin saw message:", message);
    messageListeners.forEach((listener) => listener(message));
  });

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
            headers: {
              "Content-Type": "application/json",
              // P1-4: prior token as proof (in case the cross-site cookie is blocked).
              "Authorization": `Bearer ${token || ""}`,
            },
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
            body: JSON.stringify({ name: "Guest", branchEmail, turnstileToken: await getTurnstileToken() }), // P1-4: bot check
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

  socket.once("disconnect", (reason) => {
    isConnecting = false;
    // "io client disconnect" means we called socket.disconnect() intentionally — not an error
    if (reason !== "io client disconnect") {
      console.warn("[SOCKET] 🔌 Disconnected during connect phase. Reason:", reason);
    }
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

export const offTyping = (callback) => {
  if (typeof callback === "function") {
    typingListeners.delete(callback);
  }
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