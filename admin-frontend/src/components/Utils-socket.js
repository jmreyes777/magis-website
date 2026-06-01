import { io } from "socket.io-client";
import { db } from "../firebase-config";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getSessionTabId } from "../utils/initSession";
import { waitForSessionReady } from "../utils/waitForSessionReady";
import { ensureSessionHydrated } from "../utils/sessionHydration";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "http://localhost:5000";
const HEARTBEAT_INTERVAL = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

let socketInstance = null;
let state = {
  missedPings: 0,
  reconnectAttempts: 0,
  heartbeatInterval: null,
  isConnecting: false,
};

const tabId = localStorage.getItem("tabId");
const sessionTabId = getSessionTabId();
const bc = new BroadcastChannel("admin-socket");
const openTabs = new Set([tabId]);

bc.postMessage({ type: "tab-init", tabId });

bc.onmessage = ({ data }) => {
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

window.addEventListener("beforeunload", () => {
  bc.postMessage({ type: "tab-closing", tabId });
});
window.addEventListener("unload", () => {
  bc.postMessage({ type: "tab-closing", tabId });
});

export const connectSocket = async (branchEmailParam, isPassive = false) => {
  window.__SOCKET_CONNECTED = false;

  const activeTabId = localStorage.getItem("activeSocketTabId");
  const sessionTabId = getSessionTabId();
  const tabId = localStorage.getItem("tabId");

  if (state.isConnecting || socketInstance?.connected) {
    console.warn("[SOCKET] 🚫 Skipping connect — already connected or connecting");
    return;
  }

  // 🔒 1. Hydrate session deterministically in passive tabs
  let session = {
    token: sessionStorage.getItem("branchAdminToken"),
    email: branchEmailParam || sessionStorage.getItem("branchEmail"),
  };

  if (isPassive) {
    session = await ensureSessionHydrated();
    console.info("[SOCKET] ⏳ Passive tab waited for hydration:", session);
  }

  // 🧠 2. Fallback token injection if needed
  let token = session.token;
  let freshBranchEmail = session.email;

  const fallbackEligible =
    isPassive &&
    freshBranchEmail &&
    sessionTabId &&
    (!token || token === "__FALLBACK_FAKE_TOKEN__");

  if (!token && fallbackEligible) {
    console.warn("[SOCKET] ⛑️ Fetching real fallback token for passive tab...");
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/issue-fallback-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchEmail: freshBranchEmail }),
      });

      const data = await res.json();

      if (data?.token) {
        token = data.token;
        sessionStorage.setItem("branchAdminToken", token);
        console.info("[SOCKET] 🪙 Fetched real fallback token for passive connect.");
      } else {
        console.error("[SOCKET] ❌ Failed to get fallback token. Aborting socket init.");
        return;
      }
    } catch (err) {
      console.error("[SOCKET] ❌ Error fetching fallback token:", err.message);
      return;
    }
  }

  // 🔁 3. Debug-only fallback connection
  if (!token || !freshBranchEmail || !sessionTabId) {
    console.error("[SOCKET] ❌ Missing session values after fallback attempt", {
      token,
      freshBranchEmail,
      sessionTabId,
    });

    socketInstance = io(SOCKET_URL, {
      transports: ["websocket"],
      autoConnect: true,
      reconnection: false,
      auth: {
        token: token || "__FALLBACK_FAKE_TOKEN__",
        tabId,
        sessionTabId: sessionTabId || "unknown",
        branchEmail: freshBranchEmail || "unknown",
      },
    });

    window.socketInstance = socketInstance;
    state.isConnecting = true;

    socketInstance.once("connect", () => {
      console.log("[SOCKET] 🔌 Passive fallback connection attempt finished.");
      window.__SOCKET_CONNECTED = true;
      startHeartbeat(sessionTabId);
      state.isConnecting = false;
    });

    socketInstance.on("disconnect", handleAutoReconnect);
    socketInstance.on("connect_error", (err) => {
      console.error("[SOCKET] ❌ Connection error:", err.message);
      state.isConnecting = false;
    });

    return;
  }

  // 🔁 4. Prevent double socket if not owner
  if (!isPassive && activeTabId && activeTabId !== tabId) return;

  // 🔌 5. Disconnect old socket before reconnect
  if (socketInstance?.connected) {
    await new Promise((res) => {
      socketInstance.once("disconnect", res);
      socketInstance.disconnect();
    });
  }

  // 🚀 6. Create new socket connection with guaranteed values
  socketInstance = io(SOCKET_URL, {
    transports: ["websocket"],
    autoConnect: true,
    reconnection: false,
    auth: {
      token,
      tabId,
      sessionTabId,
      branchEmail: freshBranchEmail,
    },
  });

  window.socketInstance = socketInstance;
  state.isConnecting = true;

  // 📡 7. Handle connect + heartbeat + room join
  socketInstance.once("connect", async () => {
    try {
      const shouldSetOnline = !isPassive || !localStorage.getItem("activeSocketTabId");
  
      if (shouldSetOnline) {
        localStorage.setItem("activeSocketTabId", tabId);
  
        if (token !== "__FALLBACK_FAKE_TOKEN__") {
          console.log("[SOCKET] ✅ Marking branch ONLINE in Firestore...");
          await updateBranchStatus(freshBranchEmail, true);
        }
      }
  
      // ✅ JOIN ADMIN ROOM IMMEDIATELY AFTER CONNECTION
      const adminRoom = `admin-${freshBranchEmail}`;
      socketInstance.emit("joinRoom", adminRoom);
      console.log("[SOCKET] 🏠 Joined admin room:", adminRoom);
  
      window.__SOCKET_CONNECTED = true;
      console.log("[SOCKET] 🔌 Connected — starting heartbeat");
      startHeartbeat(sessionTabId);
    } catch (error) {
      console.error("[SOCKET] ❌ Firestore update error:", error.message);
    } finally {
      state.isConnecting = false;
    }
  });  

  socketInstance.on("disconnect", handleAutoReconnect);
  socketInstance.on("connect_error", (err) => {
    console.error("[SOCKET] ❌ Connection error:", err.message);
    state.isConnecting = false;
  });
};

const startHeartbeat = (sessionTabId) => {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval); // 🔄 Reset on tab switch
  }

  state.heartbeatInterval = setInterval(async () => {
    const session = await ensureSessionHydrated(); // 🧠 Guaranteed fallback-safe read
    const token = session?.token;
    const email = session?.email;
    const tabId = localStorage.getItem("tabId");
    const activeTabId = localStorage.getItem("activeSocketTabId");
    const timestamp = Date.now();

    if (!token || !email || !sessionTabId) {
      console.warn("[HEARTBEAT] ❌ Missing session info, skipping emit", {
        tokenPresent: !!token,
        emailPresent: !!email,
        sessionTabIdPresent: !!sessionTabId,
      });
      return;
    }

    if (socketInstance?.connected) {
      socketInstance.emit("heartbeat");
      console.log("[HEARTBEAT] 🫀 Sent heartbeat");

      socketInstance.emit("tabAlive", { tabId, sessionTabId, timestamp });
      console.log("[TABALIVE] 👁️ Sent tabAlive", { tabId, sessionTabId, timestamp });

      socketInstance.emit("broadcastAlive", {
        tabId,
        sessionTabId,
        branchEmail: email,
        timestamp,
      });
      console.log("[BROADCAST] 📡 Sent broadcastAlive", { tabId, sessionTabId, timestamp });

      state.missedPings = 0;
    } else if (tabId === activeTabId && !state.isConnecting) {
      console.warn("[HEARTBEAT] ❌ Socket disconnected");
      console.warn("[HEARTBEAT] 🧪 Owner tab detected — trying reconnect...");
      connectSocket(email);
    }

    bc.postMessage({ type: "tab-alive", tabId });
    console.log("[BC] 🔁 Broadcasted tab-alive to channel");
  }, HEARTBEAT_INTERVAL);
};


const stopHeartbeat = () => {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
};

const updateBranchStatus = async (branchEmail, isOnline) => {
  try {
    const statusRef = doc(db, "branchStatus", branchEmail.toLowerCase());
    await updateDoc(statusRef, {
      online: Boolean(isOnline),
      lastSeen: serverTimestamp(),
    });
  } catch (error) {
    console.error("[FIRESTORE] ❌ Update failed:", error.message);
  }
};

export const disconnectSocket = async (branchEmail, isLogout = false) => {
  try {
    const email = branchEmail || sessionStorage.getItem("branchEmail");
    const sessionToken = sessionStorage.getItem("branchAdminToken");
    const activeTabId = localStorage.getItem("activeSocketTabId");

    if (socketInstance?.connected) {
      socketInstance.disconnect();
    }

    stopHeartbeat();

    if (email && tabId === activeTabId) {
      const branchStatusRef = doc(db, "branchStatus", email.toLowerCase());
      await updateDoc(branchStatusRef, {
        online: false,
        lastSeen: serverTimestamp(),
      });
    }

    if (!isLogout && sessionToken) return;

    sessionStorage.removeItem("branchAdminToken");
    sessionStorage.removeItem("branchEmail");
    localStorage.removeItem("activeSocketTabId");

    state.missedPings = 0;
    state.reconnectAttempts = 0;
    window.__SOCKET_CONNECTED = false;
  } catch (error) {
    console.error("[SOCKET] ❌ Disconnect error:", error.message);
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
        connectSocket(branchEmail);
      } else {
        state.reconnectAttempts = 0;
      }
    }, delay);
  }
};


export const emitMessage = (guestId, message) => {
  try {
    if (socketInstance.connected) {
      socketInstance.emit("sendMessage", { room: `guest-${guestId}`, ...message });
      console.log(`[SOCKET] Message sent to room: guest-${guestId}`, message);
    }
  } catch (error) {
    console.error("[SOCKET] Error emitting message:", error.message);
  }
};

export const onNewMessage = (callback) => {
  let attempts = 0;
  const MAX_ATTEMPTS = 10;
  const RETRY_INTERVAL = 300; // ms

  const tryAttach = () => {
    if (socketInstance && socketInstance.connected) {
      socketInstance.on("receiveMessage", (message) => {
        console.log("[SOCKET] 📥 Message event received:", message);
        callback(message);
      });
      console.log("[SOCKET] ✅ Attached onNewMessage listener");
    } else if (attempts < MAX_ATTEMPTS) {
      attempts++;
      console.warn(`[SOCKET] ⏳ Waiting for socket init... attempt ${attempts}`);
      setTimeout(tryAttach, RETRY_INTERVAL);
    } else {
      console.error("[SOCKET] ❌ Failed to attach onNewMessage listener: socket not initialized");
    }
  };

  tryAttach();
};



export const emitTyping = (guestId, senderId, isTyping) => {
  try {
    if (socketInstance.connected) {
      socketInstance.emit("typing", { room: `guest-${guestId}`, sender: senderId, isTyping });
      console.log(`[SOCKET] Typing event emitted: room=guest-${guestId}, sender=${senderId}, typing=${isTyping}`);
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

export const emitMessageSeen = (guestId, messageId) => {
  try {
    if (socketInstance.connected) {
      socketInstance.emit("markSeen", { room: `guest-${guestId}`, messageId });
      console.log(`[SOCKET] Message seen: guest-${guestId}, message ID: ${messageId}`);
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

export {
  socketInstance,
  startHeartbeat,
  updateBranchStatus
};
