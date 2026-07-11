// Admin-Utils-socket.js
import { io } from "socket.io-client";
import { db } from "../firebase-config";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getSessionTabId } from "../utils/initSession";
import { ensureSessionHydrated } from "../utils/sessionHydration";
import { getAuth } from "firebase/auth";

// Use a global namespace to avoid duplicate redeclarations (e.g. in hot module reload)
if (!window.__ADMIN_UTILS_SOCKET__) {
  window.__ADMIN_UTILS_SOCKET__ = {};
}
const globalNS = window.__ADMIN_UTILS_SOCKET__;

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "https://localhost:5000";

// Detect if we’re effectively on 2G
const conn = navigator.connection || {};
const isSlow = typeof conn.effectiveType === "string" && conn.effectiveType.includes("2g");

const HEARTBEAT_INTERVAL = (isSlow ? 2 : 1) * 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

// Best-effort fresh Firebase ID token — proof of identity for the fallback-token
// exchange (P0-1). Returns null when no Firebase session is restored yet, in
// which case the HTTP-only branchAdminToken cookie / prior token is used instead.
async function getFirebaseIdToken() {
  try {
    const u = getAuth().currentUser;
    return u ? await u.getIdToken() : null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Per-branch BroadcastChannel (lazy, namespaced, auto-updating)
// ────────────────────────────────────────────────────────────────
let adminSyncChannelRef = null;
const getAdminSyncChannel = () => {
  const be = (sessionStorage.getItem("branchEmail") || "unknown").toLowerCase().trim();
  const expected = `admin-sync:${be || "unknown"}`;
  if (!adminSyncChannelRef || adminSyncChannelRef.__name !== expected) {
    try {
      adminSyncChannelRef?.close?.();
    } catch {}
    const ch = new BroadcastChannel(expected);
    ch.__name = expected;
    adminSyncChannelRef = ch;
  }
  return adminSyncChannelRef;
};

// ────────────────────────────────────────────────────────────────
// New: server-driven unread‐count subscribers
// ────────────────────────────────────────────────────────────────
const unreadListeners = new Set();

/**
 * Dashboard can call this to get server-pushed unread counts:
 * const unsub = onUnreadUpdate(({ guestId, unreadCount }) => …);
 */
export const onUnreadUpdate = (cb) => {
  unreadListeners.add(cb);
  return () => unreadListeners.delete(cb);
};

let hasMarkedOnline = false;

export const isTokenExpired = (token) => {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
};

// --------------------
// Simple Promise-based Mutex
// --------------------
class Mutex {
  constructor() {
    this._mutex = Promise.resolve();
  }
  lock() {
    let begin = null;
    const promise = new Promise((resolve) => (begin = resolve));
    const previous = this._mutex;
    this._mutex = previous.then(() => promise);
    return previous.then(() => begin);
  }
}
const tokenRefreshMutex = new Mutex();
const rebindMutex = new Mutex();
const connectMutex = new Mutex();
const callbackMutex = new Mutex();

// Use global instance if it exists.
let socketInstance = globalNS.socketInstance || null;
let state = globalNS.state || {
  missedPings: 0,
  reconnectAttempts: 0,
  heartbeatInterval: null,
  isConnecting: false,
};

const tabId = localStorage.getItem("tabId");
const sessionTabId = getSessionTabId();
const bc = new BroadcastChannel("admin-socket");
const openTabs = new Set([tabId]);
const postConnectCallbacks = [];
const postDisconnectCallbacks = [];

// The following sets track external subscribers.
const messageListeners = new Set();
const typingListeners = new Set();
const branchStatusListeners = new Set();
const connectionListeners = new Set();

const normalizeEmail = (email = "") => email.toLowerCase().trim();
const canonGuestRoom = (id = "") => {
  const core = String(id).toLowerCase().replace(/^guest-/, "").trim();
  return `guest-${core}`;
};

// --------------------
// BroadcastChannel Listener (admin-socket coordination)
// --------------------
const handleBroadcastMessage = ({ data }) => {
  const { type, tabId: otherTabId } = data;
  if (!otherTabId || otherTabId === tabId) return;
  if (type === "tab-init" || type === "tab-alive") {
    openTabs.add(otherTabId);
    bc.postMessage({ type: "tab-alive", tabId });
  }
  if (type === "tab-closing") {
    openTabs.delete(otherTabId);
  }
};
bc.postMessage({ type: "tab-init", tabId });
bc.onmessage = handleBroadcastMessage;

// --------------------
// Storage Event & Token Refresh Locking
// --------------------
const handleStorageChange = async (event) => {
  if (event.key === "branchAdminToken" && event.newValue) {
    const newToken = event.newValue;
    const currentToken = socketInstance?.auth?.token;
    if (socketInstance?.connected && newToken && currentToken !== newToken) {
      // Use the promise-based mutex to serialize token updates.
      const release = await tokenRefreshMutex.lock();
      try {
        console.warn(
          "[SOCKET] 🔄 Token changed in another tab — reconnecting with updated token..."
        );
        socketInstance.auth.token = newToken;
        socketInstance.__messageListenerAttached = false;
        socketInstance.disconnect();
        const email = sessionStorage.getItem("branchEmail");
        if (email) {
          await connectSocket(email, true);
        }
      } catch (e) {
        console.error("[SOCKET] Error during reconnect:", e.message);
      } finally {
        release();
      }
    }
  }
};
window.addEventListener("storage", handleStorageChange);

const handleBeforeUnload = () => {
  bc.postMessage({ type: "tab-closing", tabId });
};
const handleUnload = () => {
  bc.postMessage({ type: "tab-closing", tabId });
};
window.addEventListener("beforeunload", handleBeforeUnload);
window.addEventListener("pagehide", handleUnload);

// Export a cleanup function to remove window listeners and close the BroadcastChannel.
export const cleanupAdminSocket = () => {
  window.removeEventListener("storage", handleStorageChange);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  window.removeEventListener("unload", handleUnload);
  bc.close();
};

// --------------------
// Stable Listener Callbacks
// --------------------
const handleReceiveMessage = (message) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[SOCKET] 📩 Received message:", message);
  }

  // 🔒 HARD FILTER: only deliver messages for the current branch
  const currentBE = (sessionStorage.getItem("branchEmail") || "")
    .toLowerCase()
    .trim();
  if (
    message?.branchEmail &&
    message.branchEmail.toLowerCase().trim() !== currentBE
  ) {
    return;
  }

  messageListeners.forEach((listener) => listener(message));

  // Also broadcast to same-branch tabs only (namespaced channel + include branchEmail)
  try {
    getAdminSyncChannel().postMessage({
      type: "newMessage",
      payload: message,
      branchEmail: currentBE,
    });
    if (process.env.NODE_ENV !== "production") {
      console.debug("[ADMIN SYNC] Broadcasted newMessage");
    }
  } catch (err) {
    console.warn("[ADMIN SYNC] Broadcast newMessage failed:", err.message);
  }
};

const handleBranchStatus = (status) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[SOCKET] 🔄 Branch status:", status);
  }
  branchStatusListeners.forEach((listener) => listener(status));
};

const handleDisconnect = async (reason) => {
  console.warn(`[SOCKET] ❌ Disconnected: ${reason}`);
  state.isConnecting = false;
  const token = sessionStorage.getItem("branchAdminToken");
  if (!token) {
    console.debug("[SOCKET] No active session, skipping reconnect.");
    return;
  }
  if (reason !== "io client disconnect" && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    const delay = Math.min(1000 * 2 ** state.reconnectAttempts, 30000);
    state.reconnectAttempts++;
    setTimeout(() => {
      if (!socketInstance.connected) {
        connectSocket(token); // Reconnect for admin using token
      } else {
        state.reconnectAttempts = 0;
      }
    }, delay);
  }
};

const notifyConnectionStatus = (isConnected) => {
  connectionListeners.forEach((cb) => cb(isConnected));
};

// --------------------
// Socket Instance and Listener Initialization
// --------------------
const initializeSocketListeners = (sock) => {
  if (sock.hasInitializedListeners) return;
  sock.hasInitializedListeners = true;
  sock.off("receiveMessage", handleReceiveMessage);
  sock.off("branchStatus", handleBranchStatus);
  sock.off("disconnect", handleDisconnect);
  sock.off("connect", notifyConnectionStatus);
  sock.off("disconnect", notifyConnectionStatus);

  sock.on("receiveMessage", handleReceiveMessage);

  // ── Server pushes authoritative unread counts ──────────────────
  sock.on("updateUnread", ({ guestId, unreadCount }) => {
    unreadListeners.forEach((cb) => cb({ guestId, unreadCount }));
  });

  // ── Guest has seen an admin message ───────────────────────────
  sock.on("messageSeenByGuest", (message) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[SOCKET] ✅ Guest saw message:", message);
    }
    messageListeners.forEach((listener) => listener(message));
  });

  sock.on("branchStatus", handleBranchStatus);

  sock.on("connect", () => {
    state.reconnectAttempts = 0;
    state.missedPings = 0;
    state.isConnecting = false;
    notifyConnectionStatus(true);

    window.dispatchEvent(new Event("adminSocketReconnected"));

    console.debug("[SOCKET] ✅ Admin socket connected — initializing");

    // Force __suppressDisconnect permanently for admin users.
    if (sock.user && (sock.user.role === "admin" || sock.user.role === "branchadmin")) {
      sock.__suppressDisconnect = true;
      console.log(
        "[SOCKET] Admin user detected – setting __suppressDisconnect = true permanently"
      );
    }

    startHeartbeat(getSessionTabId());
    const be = (sessionStorage.getItem("branchEmail") || "").toLowerCase().trim();
    const adminRoom = `admin-${be}`;
    sock.emit("joinRoom", adminRoom, () => {
      console.log("[SOCKET] 🏠 Joined admin room:", adminRoom);
    });
  });

  sock.on("disconnect", (reason) => {
    state.isConnecting = false;
    notifyConnectionStatus(false);
    console.warn("[SOCKET] ❌ Disconnected:", reason);
  });
};

export const getSocketInstance = () => {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: false,
      perMessageDeflate: true,
      auth: {
        token: sessionStorage.getItem("branchAdminToken"),
        tabId,
        sessionTabId,
        branchEmail: sessionStorage.getItem("branchEmail"),
      },
    });
    initializeSocketListeners(socketInstance);
    globalNS.socketInstance = socketInstance;
    globalNS.state = state;
  }
  return socketInstance;
};

const sock = getSocketInstance();

// Immediately update __suppressDisconnect based on visibility changes
document.addEventListener("visibilitychange", () => {
  if (
    socketInstance &&
    socketInstance.user &&
    (socketInstance.user.role === "admin" || socketInstance.user.role === "branchadmin")
  ) {
    // For admin users, always keep __suppressDisconnect true regardless of visibility.
    socketInstance.__suppressDisconnect = true;
    console.log("[SOCKET] Admin visibility change – always keeping __suppressDisconnect = true");
    // Optionally, if the tab becomes visible, emit an immediate heartbeat.
    if (document.visibilityState === "visible" && socketInstance.connected) {
      socketInstance.emit("heartbeat");
      console.log("[SOCKET] Emitted immediate heartbeat on visibility change (admin)");
    }
  }
});

// ────────────────────────────────────────────────────────────────
// Network connection detection: on offline → real disconnect;
// on online  → auto-reconnect (so messages queue & replay properly).
window.addEventListener("offline", () => {
  console.warn("[NETWORK] ⚠️ Browser offline detected — disconnecting admin socket");
  if (socketInstance?.connected) {
    socketInstance.disconnect(); // triggers server-side 'disconnect'
  }
});

window.addEventListener("online", async () => {
  console.info("[NETWORK] ✅ Browser online detected — reconnecting admin socket");
  const email = sessionStorage.getItem("branchEmail");
  if (email) {
    try {
      // passive=true reuses existing tokens, joins rooms, replays missed messages
      await connectSocket(email, /* isPassive */ true);
      console.log("[NETWORK] 🔄 Admin socket reconnected after network restore");
    } catch (err) {
      console.error("[NETWORK] ❌ Failed to reconnect admin socket:", err);
    }
  }
});

// ────────────────────────────────────────────────────────────────
// Electron desktop app only: OS power transitions (see preload.js).
// Mirrors the offline/online strategy across system sleep:
//   suspend → clean disconnect so the server parks the session and queues
//             undelivered messages instead of waiting for heartbeat timeout;
//   resume  → forced clean reconnect (passive) so queued messages replay
//             INSTANTLY. `connected` can be stale-true after a sleep the
//             suspend event never announced, so we always cycle.
if (window.electronAPI?.onPowerEvent) {
  const reconnectAfterWake = async (attempt = 0) => {
    const email = sessionStorage.getItem("branchEmail");
    if (!email) return; // not logged in — nothing to revive
    try {
      await connectSocket(email, /* isPassive */ true);
      console.log("[POWER] 🔄 Admin socket reconnected after system wake");
    } catch (err) {
      if (attempt < 2) {
        console.warn(`[POWER] ⚠️ Wake reconnect failed (attempt ${attempt + 1}/3) — retrying in 5s`);
        setTimeout(() => reconnectAfterWake(attempt + 1), 5000);
      } else {
        console.error("[POWER] ❌ Failed to reconnect admin socket after wake:", err);
      }
    }
  };

  window.electronAPI.onPowerEvent(({ event }) => {
    if (event === "suspend") {
      console.warn("[POWER] 💤 System suspending — parking admin socket cleanly");
      if (socketInstance?.connected) socketInstance.disconnect();
    } else if (event === "resume") {
      console.info("[POWER] ⏰ System resumed — reviving admin socket");
      if (socketInstance?.connected) socketInstance.disconnect();
      setTimeout(() => reconnectAfterWake(), 2000); // give the NIC a moment to come back
    } else if (event === "unlock-screen") {
      // Screen lock alone doesn't kill the socket — only heal if it's down.
      if (!socketInstance?.connected) reconnectAfterWake();
    }
  });
  console.log("[POWER] 🔌 Electron power-event bridge active");
}

// --------------------
// Connect, Disconnect, and Tab Close Functions
// --------------------
export const connectSocket = async (branchEmailParam, isPassive = false) => {
  // Acquire the connect lock before entering any connect/disconnect logic
  const release = await connectMutex.lock();
  try {
    window.__SOCKET_CONNECTED = false;
    const activeTabId = localStorage.getItem("activeSocketTabId");
    const currSessionTabId = getSessionTabId();
    const currentTabId = localStorage.getItem("tabId");

    let session = {
      token: sessionStorage.getItem("branchAdminToken"),
      email: normalizeEmail(branchEmailParam || sessionStorage.getItem("branchEmail")),
    };

    if (isPassive) {
      session = await ensureSessionHydrated();
      console.info("[SOCKET] ⏳ Passive tab hydrated:", session);
    }

    let { token, email: freshBranchEmail } = session;
    freshBranchEmail = normalizeEmail(freshBranchEmail);
    sessionStorage.setItem("branchEmail", freshBranchEmail);

    const fallbackEligible =
      isPassive &&
      freshBranchEmail &&
      currSessionTabId &&
      (!token || token === "__FALLBACK_FAKE_TOKEN__");

    // Refresh expired fallback token
    if (isPassive && isTokenExpired(token)) {
      console.warn("[SOCKET] ⚠️ Expired fallback token detected — reissuing...");
      try {
        // Prove prior auth so the backend will rotate the token (P0-1): a fresh
        // Firebase ID token when available, plus the just-expired HMAC token.
        const fbToken = await getFirebaseIdToken();
        const res = await fetch(`${process.env.REACT_APP_API_URL}/api/issue-fallback-token`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(fbToken ? { Authorization: `Bearer ${fbToken}` } : {}),
          },
          body: JSON.stringify({ branchEmail: freshBranchEmail, currentToken: token }),
        });
        const data = await res.json();
        if (data?.token) {
          token = data.token;
          sessionStorage.setItem("branchAdminToken", token);
          localStorage.setItem("branchAdminToken", token);
          console.info("[SOCKET] ✅ Refreshed fallback token");
        } else {
          console.error("[SOCKET] ❌ Failed to refresh fallback token");
          return;
        }
      } catch (err) {
        console.error("[SOCKET] ❌ Error during token refresh:", err.message);
        return;
      }
    }

    // Handle other fallback‐eligible cases
    if (fallbackEligible) {
      console.warn("[SOCKET] ⛑️ Fetching real fallback token for passive connect...");
      try {
        // Prove prior auth (P0-1): attach a fresh Firebase ID token when a session
        // is restored; the HTTP-only cookie (credentials) is the rotation fallback.
        const fbToken = await getFirebaseIdToken();
        const res = await fetch(`${process.env.REACT_APP_API_URL}/api/issue-fallback-token`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(fbToken ? { Authorization: `Bearer ${fbToken}` } : {}),
          },
          body: JSON.stringify({ branchEmail: freshBranchEmail }),
        });
        const data = await res.json();
        if (data?.token) {
          token = data.token;
          sessionStorage.setItem("branchAdminToken", token);
          localStorage.setItem("branchAdminToken", token);
          if (!sessionStorage.getItem("branchEmail")) {
            sessionStorage.setItem("branchEmail", freshBranchEmail);
          }
          console.info("[SOCKET] 🪙 Fetched real fallback token for passive connect");
        } else {
          console.error("[SOCKET] ❌ Failed to get fallback token. Aborting.");
          return;
        }
        session.token = token;
        freshBranchEmail = session.email = normalizeEmail(freshBranchEmail);
      } catch (err) {
        console.error("[SOCKET] ❌ Error fetching fallback token:", err.message);
        return;
      }
    }

    if (!token || token === "__FALLBACK_FAKE_TOKEN__") {
      console.error("[SOCKET] 🚫 Aborting connect — invalid token after fallback hydration");
      return;
    }

    // If we’re already connected with a stale token, force a clean reconnect
    if (socketInstance?.connected && socketInstance.auth?.token !== token) {
      console.warn("[SOCKET] 🔁 Token mismatch detected — disconnecting for clean rejoin");
      socketInstance.disconnect();
    }

    // If still connected, just re-join and rebind listeners
    if (socketInstance?.connected) {
      const adminRoom = `admin-${freshBranchEmail}`;
      socketInstance.emit("joinRoom", adminRoom);
      console.log("[SOCKET] 🔁 Already connected — rejoining admin room:", adminRoom);

      try {
        const { default: BranchChatDashboard } = require("../pages/Branch-Chat-Dashboard");
        BranchChatDashboard._rebindSocketListeners?.();
        console.log("[SOCKET] ✅ Forced listener rebind (hot connect)");
      } catch (e) {
        console.warn("[SOCKET] ⚠️ Listener rebind failed on hot connect:", e.message);
      }

      if (postConnectCallbacks.length > 0) {
        console.log("[SOCKET] 🔁 Running postConnect callbacks (hot connect)...");
        postConnectCallbacks.forEach((cb) => cb(socketInstance));
        postConnectCallbacks.length = 0;
      }

      // ← NEW: notify dashboard to recalculate missed messages
      window.dispatchEvent(new Event("adminSocketReconnected"));
      console.info("[SOCKET] 🔄 Admin socket reconnected (hot connect)");

      return;
    }

    // Otherwise create a fresh socket instance
    socketInstance = io(SOCKET_URL, {
      transports: ["websocket"],
      autoConnect: true,
      reconnection: false,
      perMessageDeflate: true,
      auth: {
        token,
        tabId: currentTabId,
        sessionTabId: currSessionTabId,
        branchEmail: freshBranchEmail,
      },
    });

    // Pre-connect rebind hook
    try {
      const { default: BranchChatDashboard } = require("../pages/Branch-Chat-Dashboard");
      BranchChatDashboard.__rebindSocketListeners?.();
      console.log("[SOCKET] 🧠 Pre-connect listener rebind complete");
    } catch (e) {
      console.warn("[SOCKET] ⚠️ Pre-connect rebind failed:", e.message);
    }

    window.socketInstance = socketInstance;

    initializeSocketListeners(socketInstance);

    // Provide a mutex-protected rebind helper for after joinRoom
    socketInstance.__rebindListeners = async () => {
      const releaseRebind = await rebindMutex.lock();
      try {
        const { default: BranchChatDashboard } = require("../pages/Branch-Chat-Dashboard");
        BranchChatDashboard._rebindSocketListeners?.();
        console.log("[SOCKET] 🧠 __rebindListeners triggered");
      } catch (e) {
        console.warn("[SOCKET] ⚠️ __rebindListeners hook failed:", e.message);
      } finally {
        releaseRebind();
      }
    };
    window.__ADMIN_SOCKET_REBINDER__ = socketInstance.__rebindListeners;
    state.isConnecting = true;

    socketInstance.once("connect", async () => {
      // 🔁 First, ensure our receiveMessage handler is attached
      if (!socketInstance.__messageListenerAttached) {
        initializeSocketListeners(socketInstance);
        console.log("[ADMIN] 🔁 Rebound receiveMessage before joinRoom");
      }
      try {
        const adminRoom = `admin-${freshBranchEmail}`;
        socketInstance.emit("joinRoom", adminRoom, async () => {
          socketInstance.emit("confirmReady", {
            branchEmail: freshBranchEmail,
            sessionTabId: currSessionTabId,
          });
          console.log(
            `[SOCKET] ✅ joinRoom ACK — confirmReady emitted for ${freshBranchEmail} (${currSessionTabId})`
          );
          socketInstance.__joinedRoom = true;

          // Perform rebind under mutex
          if (typeof socketInstance.__rebindListeners === "function") {
            await socketInstance.__rebindListeners();
            console.log("[SOCKET] ✅ Listeners rebind complete after joinRoom");
          }

          // Mark online if this tab should own the socket
          // Only ever mark online once per real login
          const shouldSetOnline =
            (!isPassive || !localStorage.getItem("activeSocketTabId")) && !hasMarkedOnline;
          if (shouldSetOnline && token !== "__FALLBACK_FAKE_TOKEN__") {
            hasMarkedOnline = true;
            localStorage.setItem("activeSocketTabId", currentTabId);
            console.log("[SOCKET] ✅ Marking branch ONLINE in Firestore...");
            try {
              await updateBranchStatus(freshBranchEmail, true);
            } catch (err) {
              console.error("[SOCKET] ❌ Failed to mark branch ONLINE:", err);
            }
          }

          window.__SOCKET_CONNECTED = true;
          console.log("[SOCKET] 🔌 Connected and joined room — starting heartbeat");
          startHeartbeat(currSessionTabId);

          // Run and clear post-connect callbacks under the same rebind mutex
          const releaseCallbacks = await connectMutex.lock();
          try {
            postConnectCallbacks.forEach((cb) => cb(socketInstance));
            postConnectCallbacks.length = 0;
          } finally {
            releaseCallbacks();
          }

          // Rebind onNewMessage hook if provided
          try {
            const { onNewMessage } = require("./Admin-Utils-socket");
            const { default: BranchChatDashboard } = require("../pages/Branch-Chat-Dashboard");
            onNewMessage((message) => {
              BranchChatDashboard._rebindSocketListeners?.();
              console.log("[SOCKET] 🔁 Forced rebind from onNewMessage callback");
            });
            console.log("[SOCKET] ✅ Post-connect message rebind hook registered");
          } catch (e) {
            console.warn("[SOCKET] ⚠️ Failed to patch post-connect listener:", e.message);
          }
        });
        console.log(
          `[SOCKET] ⏳ Sent joinRoom for admin-${freshBranchEmail} — awaiting confirmReady...`
        );
      } catch (error) {
        console.error("[SOCKET] ❌ Firestore update error:", error.message);
      } finally {
        state.isConnecting = false;
      }
    });

    // Immediately reconnect so we re-join our admin room
    console.info("[SOCKET] 🔄 Detected server disconnect, reconnecting...");
    socketInstance.connect();

    socketInstance.on("disconnect", (reason) => {
      // ─── FIRE offline callbacks ───────────────────────────
      callbackMutex.lock().then((release) => {
        try {
          postDisconnectCallbacks.forEach((cb) => cb(socketInstance));
          postDisconnectCallbacks.length = 0;
        } finally {
          release();
        }
      });
      // ─── existing teardown & auto-reconnect ───────────────
      socketInstance.removeAllListeners("receiveMessage");
      socketInstance.removeAllListeners("guestPresenceUpdate");
      socketInstance.removeAllListeners("chatClosed");
      socketInstance.__messageListenerAttached = false;
      handleAutoReconnect(reason);
    });

    socketInstance.on("connect_error", (err) => {
      console.error("[SOCKET] ❌ Connection error:", err.message);
      state.isConnecting = false;
    });
  } finally {
    // Always release the connect lock
    release();
  }
};

// --------------------
// Heartbeat Functions
// --------------------
const startHeartbeat = (currSessionTabId) => {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
  }
  state.heartbeatInterval = setInterval(async () => {
    const session = await ensureSessionHydrated();
    const token = session?.token;
    const email = session?.email ? session.email.toLowerCase().trim() : "";
    const currentTabId = localStorage.getItem("tabId");
    const timestamp = Date.now();

    if (!token || !email || !currSessionTabId) {
      console.warn("[HEARTBEAT] ❌ Missing session info, skipping emit");
      return;
    }

    // ─── Handle hidden-tab exactly like visible-tab ────────────────
    if (document.visibilityState === "hidden") {
      console.log("[HEARTBEAT] Tab is hidden; still sending full presence");
      if (socketInstance) {
        socketInstance.__suppressDisconnect = true;
      }
      state.missedPings = 0;

      // BroadcastChannel for multi-tab
      bc.postMessage({ type: "tab-alive", tabId: currentTabId });

      if (socketInstance?.connected) {
        socketInstance.emit("heartbeat");
        socketInstance.emit("tabAlive", {
          tabId: currentTabId,
          sessionTabId: currSessionTabId,
          timestamp,
        });
        socketInstance.emit("broadcastAlive", {
          tabId: currentTabId,
          sessionTabId: currSessionTabId,
          branchEmail: email,
          timestamp,
        });
        console.log("[HEARTBEAT] (hidden) Sent heartbeat + tabAlive + broadcastAlive");
      }
      return;
    } else {
      if (socketInstance) {
        socketInstance.__suppressDisconnect = false;
      }
    }

    // ─── Visible-tab: same as before ───────────────────────────────
    if (socketInstance?.connected) {
      socketInstance.emit("heartbeat");
      socketInstance.emit("tabAlive", {
        tabId: currentTabId,
        sessionTabId: currSessionTabId,
        timestamp,
      });
      socketInstance.emit("broadcastAlive", {
        tabId: currentTabId,
        sessionTabId: currSessionTabId,
        branchEmail: email,
        timestamp,
      });
      console.log("[HEARTBEAT] Sent heartbeat + tabAlive + broadcastAlive");
      state.missedPings = 0;
    } else if (!state.isConnecting) {
      console.warn("[HEARTBEAT] Socket disconnected — reconnecting");
      connectSocket(email);
    }

    // Keep BroadcastChannel in sync
    bc.postMessage({ type: "tab-alive", tabId: currentTabId });
    console.log("[BC] Broadcasted tab-alive");
  }, HEARTBEAT_INTERVAL);
};

const stopHeartbeat = () => {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
};

/**
 * Attempts a direct Firestore update only for superadmins,
 * then always falls back to the backend REST API for everyone.
 */
const updateBranchStatus = async (branchEmail, isOnline) => {
  try {
    const statusRef = doc(db, "branchStatus", branchEmail.toLowerCase());
    await updateDoc(statusRef, { online: Boolean(isOnline), lastSeen: serverTimestamp() });
  } catch (error) {
    console.error("[FIRESTORE] ❌ Update failed:", error.message);
  }
};

export const disconnectSocket = async (branchEmail, isLogout = false) => {
  // Serialize disconnects with the same mutex as connectSocket
  const release = await connectMutex.lock();
  try {
    const email = branchEmail || sessionStorage.getItem("branchEmail");
    const currentTabId = localStorage.getItem("tabId");
    const activeTabId = localStorage.getItem("activeSocketTabId");
    // P3-4: authenticate the offline beacon/fetch via a token in the JSON body
    // (not a ?token= query param, which leaks into logs/history/referrers). The
    // backend resolves the branch from the token and ignores the body email.
    const adminToken =
      sessionStorage.getItem("branchAdminToken") ||
      localStorage.getItem("branchAdminToken") ||
      "";
    const url = `${process.env.REACT_APP_API_URL}/api/update-status`;

    // Always tear down the socket and heartbeat first
    if (socketInstance?.connected) {
      socketInstance.disconnect();
    }
    stopHeartbeat();

    // Only the active‐owner tab should mark offline
    if (email && currentTabId === activeTabId) {
      const payload = {
        // server.js accepts either `email` or `branchEmail`
        email,
        branchEmail: email,
        online: false,
        lastSeen: new Date().toISOString(),
        token: adminToken, // P3-4: token travels in the body, not the URL
      };

      // Interactive logout: use fetch
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.info("[SOCKET] 🔔 Sent offline status via REST");
    }

    // Clear client session
    sessionStorage.removeItem("branchAdminToken");
    sessionStorage.removeItem("branchEmail");
    localStorage.removeItem("activeSocketTabId");

    // Reset in-memory state
    state.missedPings = 0;
    state.reconnectAttempts = 0;
    window.__SOCKET_CONNECTED = false;
    hasMarkedOnline = false;
  } catch (error) {
    console.error("[SOCKET] ❌ Disconnect error:", error.message);
  } finally {
    release();
  }
};

const handleAutoReconnect = async (reason) => {
  const token = sessionStorage.getItem("branchAdminToken");
  const branchEmail = sessionStorage.getItem("branchEmail");
  if (!token || !branchEmail) return;
  if (reason !== "io client disconnect" && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    const delay = Math.min(1000 * 2 ** state.reconnectAttempts, 30000);
    state.reconnectAttempts++;
    setTimeout(() => {
      if (!socketInstance.connected) {
        console.info(
          "[SOCKET] Auto-reconnect triggered, rejoining admin room + rebind listeners"
        );
        // reuse the existing auth payload

        initializeSocketListeners(socketInstance);
        socketInstance.connect();
        socketInstance.once("connect", async () => {
          const room = `admin-${(sessionStorage.getItem("branchEmail") || "")
            .toLowerCase()
            .trim()}`;
          socketInstance.emit("joinRoom", room, () => {
            console.log("[SOCKET] 🔁 Re-joined admin room on auto-reconnect", room);
          });
          // rebind any onNewMessage hooks
          await socketInstance.__rebindListeners();
          // trigger UI refresh
          window.dispatchEvent(new Event("adminSocketReconnected"));
        });
      } else {
        state.reconnectAttempts = 0;
      }
    }, delay);
  }
};

export const onNewMessage = (callback) => {
  if (!socketInstance) {
    console.warn("[SOCKET] ⚠️ No socketInstance available yet");
    return;
  }
  const handler = (message) => {
    console.log("[SOCKET] � HANDLER CALLED - File loaded correctly");
    console.log("[SOCKET] �📥 Message event received (admin):", message);
    if (!message?.guestId || !message?.timestamp || !message?.id) {
      console.warn("[SOCKET] ⚠️ Message ignored — missing required fields.");
      return;
    }

    // 🔒 HARD FILTER (double safety): only pass messages for this branch
    const currentBE = (sessionStorage.getItem("branchEmail") || "")
      .toLowerCase()
      .trim();
    if (
      message?.branchEmail &&
      message.branchEmail.toLowerCase().trim() !== currentBE
    ) {
      return;
    }

    // Call the callback
    callback(message);

    // Also broadcast the new message so all admin tabs of THIS BRANCH sync up
    try {
      getAdminSyncChannel().postMessage({
        type: "newMessage",
        payload: message,
        branchEmail: currentBE,
      });
      console.log("[ADMIN SYNC] Broadcasted newMessage");
    } catch (err) {
      console.warn("[ADMIN SYNC] Broadcast newMessage failed:", err.message);
    }
  };
  const rebindHandler = async () => {
    const release = await rebindMutex.lock();
    try {
      socketInstance.off("receiveMessage", handler);
      if (!socketInstance.__messageListenerAttached) {
        socketInstance.on("receiveMessage", handler);
        socketInstance.__messageListenerAttached = true;
        console.log("[SOCKET] ✅ Bound receiveMessage listener (admin)");
      } else {
        socketInstance.on("receiveMessage", handler);
        console.log("[SOCKET] 🔁 Rebound receiveMessage after reconnect (admin)");
      }
    } finally {
      release();
    }
  };
  rebindHandler();
  socketInstance.off("connect", rebindHandler);
  socketInstance.on("connect", () => {
    socketInstance.__messageListenerAttached = false;
    rebindHandler();
  });
  postConnectCallbacks.push(rebindHandler);
};

export const onSocketConnected = (fn) => {
  if (socketInstance?.connected) {
    // If we’re already connected, call handler immediately
    fn(socketInstance);
  } else {
    // Otherwise queue it under our mutex
    callbackMutex.lock().then((release) => {
      try {
        postConnectCallbacks.push(fn);
      } finally {
        release();
      }
    });
  }
};

// ─────────────────────────────────────────────────────────────
// Register a handler to run when the socket disconnects
export const onSocketDisconnected = (fn) => {
  // If we’re already disconnected (or never connected), call immediately
  if (!socketInstance || !socketInstance.connected) {
    fn(socketInstance);
  } else {
    // Otherwise queue it until the next real disconnect event
    callbackMutex.lock().then((release) => {
      try {
        postDisconnectCallbacks.push(fn);
      } finally {
        release();
      }
    });
  }
};

// ─────────────────────────────────────────────────────────────
// Live connection-status subscription for UI indicators.
// Reuses the existing `connectionListeners` bus, which `notifyConnectionStatus`
// fires on every socket `connect` (true) / `disconnect` (false). The callback is
// invoked immediately with the current state, then on every change. Returns an
// unsubscribe function. Safe to call repeatedly (e.g. from a React effect).
export const subscribeConnectionStatus = (cb) => {
  if (typeof cb !== "function") return () => {};
  connectionListeners.add(cb);
  // Fire immediately with the current known state so the UI starts correct.
  try {
    cb(!!(socketInstance && socketInstance.connected));
  } catch (_) {}
  return () => {
    connectionListeners.delete(cb);
  };
};

export const emitTyping = (guestId, senderId, isTyping) => {
  try {
    if (socketInstance.connected) {
      const room = canonGuestRoom(guestId);
      socketInstance.emit("typing", { room, sender: senderId, isTyping });
      console.log(
        `[SOCKET] Typing event emitted: room=${room}, sender=${senderId}, typing=${isTyping}`
      );
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting typing event:", error.message);
  }
};

export const onTyping = (callback) => {
  try {
    socketInstance.on("typing", (data) => {
      console.log("[SOCKET] Typing event received:", data);
      callback(data);
    });
  } catch (error) {
    console.error("[SOCKET] Error listening for typing events:", error.message);
  }
};

// ── Allow removal of that listener ─────────────────────────
export const offTyping = (callback) => {
  try {
    socketInstance.off("typing", callback);
  } catch (error) {
    console.error("[SOCKET] Error removing typing listener:", error.message);
  }
};

export const emitMessageSeen = (guestId, messageId) => {
  try {
    if (socketInstance.connected) {
      socketInstance.emit("markSeen", { room: `guest-${guestId}`, messageId });
      console.log(
        `[SOCKET] Message seen emitted: guest-${guestId}, message ID: ${messageId}`
      );
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting message seen event:", error.message);
  }
};

export const onMessageSeen = (callback) => {
  try {
    socketInstance.on("messageSeen", (data) => {
      console.log("[SOCKET] Message seen event received:", data);
      callback(data);
    });
  } catch (error) {
    console.error("[SOCKET] Error listening for message seen events:", error.message);
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

export { socketInstance, startHeartbeat, updateBranchStatus };
