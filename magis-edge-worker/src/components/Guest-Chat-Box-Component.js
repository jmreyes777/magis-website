import React, { useState, useEffect, useRef,useCallback } from "react";
import {
  getSocketInstance,
  connectSocket,
  disconnectSocket,
  emitTyping,
  onNewMessage,
  offBranchStatus,
  offTyping,
  offNewMessage,
  emitMessageSeen,
  onTyping,
  onBranchStatus,
  onGuestConnectionStatusChange,
  offGuestConnectionStatusChange,
  onConnectionStatus,
  offConnectionStatus,
  sendMessage
} from "../Shared/User-Utils-socket";
import { db } from "../firebase-config";
import {
  collection,
  query,
  where,
  getDocs,
  writeBatch,
} from "firebase/firestore";
import MessageItem from "../Shared/Message-Item-Component";
import ImagePreview from "../Shared/ImagePreview-Component";
import "./Guest-Chat-Box-Component.css";
import TranscriptModal from "../components/TranscriptModal";

const socket = getSocketInstance();

// Helper to generate a unique temporary identifier for optimistic messages

const generateTempId = () => { return "temp-" + Date.now() + "-" + Math.random().toString(36).substring(2, 10); };

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

function debounce(fn, ms = 1000) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── 1) Fetch & cache CSRF token ────────────────────────────────────────
async function fetchCsrfToken() {
  try {
    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/api/csrf-token`,
      { credentials: "include" }
    );
    const { csrfToken } = await res.json();
    if (csrfToken) {
      window.__CSRF_TOKEN__ = csrfToken;
      console.debug("[GUEST] 🔐 CSRF token fetched");
    } else {
      console.warn("[GUEST] ⚠️ No CSRF token in response");
    }
  } catch (err) {
    console.error("[GUEST] ❌ Failed to fetch CSRF token:", err.message);
    throw err;
  }
}

// ── 2) Ensure guest JWT is fresh — now with CSRF header ─────────────────
async function ensureValidGuestToken() {
  const token = sessionStorage.getItem("guestToken");
  if (!token) throw new Error("No guest token available");
  const payload = parseJwt(token);
  if (!payload?.exp) return; // un-recognised token shape

  const expiresAt = payload.exp * 1000;
  // If it’s expired or within 60s of expiry:
  if (Date.now() >= expiresAt - 60 * 1000) {
    console.debug("[GUEST] ⚙️ Token near expiry, refreshing now…");
    // 2a) Make sure we have a CSRF token
    if (!window.__CSRF_TOKEN__) {
      await fetchCsrfToken();
    }
    // 2b) Call the refresh‐token endpoint with CSRF header
    const res = await fetch(
      `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
      {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": window.__CSRF_TOKEN__ },
      }
    );
    if (!res.ok) throw new Error("Unable to refresh guest token");
    console.debug("[GUEST] ✅ Guest token refreshed proactively");
  }
}

async function fetchWithBackoff(url, options, maxRetries = 5, backoffMs = 1000) {
  let tries = 0;
  let delay = backoffMs;
  while (true) {
    const res = await fetch(url, options);
    if (res.status !== 429) {
      return res;
    }
    if (tries >= maxRetries) {
      throw new Error("Rate limit exceeded");
    }
    // wait
    await new Promise(r => setTimeout(r, delay));
    tries++;
    delay *= 2;
  }
}

function isTokenExpired(jwt) {
  if (!jwt) return true;
  try {
    const [, payloadB64] = jwt.split('.');
    const { exp } = JSON.parse(atob(payloadB64));
    return exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

const GuestChatBox = ({ branchId, branchEmail, branchName, guestId, onClose  }) => {
  const [localBranchId, setLocalBranchId] = useState(branchId || "");
  const [guestDetails, setGuestDetails] = useState({ name: "", phone: "", email: "" });
  const [isDetailsSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [media, setMedia] = useState(null);
  // media = image attached to chat; previewFile = file shown in modal
  const [previewFile, setPreviewFile] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [branchStatus, setBranchStatus] = useState({ online: false, lastSeen: "Unknown" });
  const [typingIndicator, setTypingIndicator] = useState(null);
  const inputFileRef = useRef(null);
  const [isMinimized, setIsMinimized]   = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [isClosing, setIsClosing]       = useState(false);
  const [isConnected, setIsConnected]   = useState(true);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [transcriptSuccessMsg, setTranscriptSuccessMsg] = useState("");
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  //Network Information API
  const [networkType, setNetworkType] = useState(
    navigator.connection?.effectiveType || 'unknown'
  );
  const isSlow = networkType.includes('2g');

  // ── 1) Create a debounced setter so any quick flip <1s is ignored
    const debouncedSetBranchStatus = useRef(
      debounce((status) => {
        setBranchStatus({
          online: !!status.online,
          lastSeen: status.lastSeen
            ? formatLastSeen(status.lastSeen)
            : "Unknown",
        });
      }, 1000)
    ).current;

  useEffect(() => {
    const connection = navigator.connection;
    if (!connection) return;

    const update = () => {
      console.log(`[NETWORK] connection changed → ${connection.effectiveType}`);
      setNetworkType(connection.effectiveType);
    };

    connection.addEventListener('change', update);
    return () => connection.removeEventListener('change', update);
  }, []);
  

useEffect(() => {
  const handleWake = async () => {
    // Prefer the persisted guestId in localStorage, fallback to sessionStorage
    const guestId =
      localStorage.getItem("guestId") ||
      sessionStorage.getItem("guestId");
    const branchEmail = sessionStorage.getItem("branchEmail");

    // Only act when tab becomes visible
    if (document.visibilityState !== "visible") return;

    // If we're disconnected but have a valid session, reconnect (and refresh token if needed)
    if (!socket?.connected) {
      if (guestId && branchEmail) {
        console.info("[GUEST] 💤 Wake detected — reconnecting socket for", guestId);
        await connectSocket(guestId);
      } else {
        console.warn(
          "[GUEST] ❌ Wake triggered but no valid session — cannot reconnect",
          { guestId, branchEmail }
        );
      }
    } else {
      console.debug("[GUEST] 💤 Wake detected — already connected, nothing to do.");
    }
  };

  document.addEventListener("visibilitychange", handleWake);
  window.addEventListener("focus", handleWake);

  return () => {
    document.removeEventListener("visibilitychange", handleWake);
    window.removeEventListener("focus", handleWake);
  };
}, []);

// ✅ Wrap retrySendMessage in useCallback to stabilize its identity
const retrySendMessage = useCallback(
  async (retryMessage, retryMedia = null) => {
    // — Prevent accidental onClick event being treated as the message:
    const isEvent =
      retryMessage &&
      typeof retryMessage === "object" &&
      retryMessage.nativeEvent;
    const contentToRetry =
      !isEvent && typeof retryMessage === "string" ? retryMessage : "";
    const mediaToRetry = !isEvent
      ? retryMedia !== null
        ? retryMedia
        : media || previewFile
      : null;

    if (!contentToRetry.trim() && !mediaToRetry) {
      console.warn("[RETRY] ⚠️ Cannot retry an empty message.");
      return;
    }
    if (!isConnected) {
      console.warn("[RETRY] ⚠️ Cannot retry while offline.");
      return;
    }

    // 0️⃣ Drop the old failed entry
    setMessages((prev) =>
      prev.filter((m) => !(m.status === "failed" && m.content === contentToRetry))
    );

    // 1️⃣ New tempId
    const tempId = generateTempId();

    // 2️⃣ Optimistic retry entry
    const optimistic = {
      guestId,
      branchEmail,
      sender: "guest",
      content: contentToRetry,
      message: contentToRetry,
      media: mediaToRetry,
      timestamp: new Date().toISOString(),
      pending: true,
      status: "sent",
      tempId,
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const token =
        sessionStorage.getItem("guestToken") ||
        localStorage.getItem("guestToken");
      const url = `${process.env.REACT_APP_API_URL}/api/messages/send`;

      // 3️⃣ Build fetch options with cookies + auth header
      const opts = {
        method: "POST",
        credentials: "include",
        headers: {},
        body: null,
      };

      if (mediaToRetry) {
        // multipart
        const formData = new FormData();
        formData.append("branchId", localBranchId);
        formData.append("branchEmail", branchEmail);
        formData.append("guestId", guestId);
        formData.append("content", contentToRetry);
        formData.append("media", mediaToRetry);
        opts.body = formData;
        if (token) opts.headers.Authorization = `Bearer ${token}`;

        // DEBUG: log FormData entries
        for (let [k, v] of formData.entries()) {
          console.log("[DEBUG][RETRY] FormData:", k, v);
        }
      } else {
        // JSON
        opts.headers["Content-Type"] = "application/json";
        if (token) opts.headers.Authorization = `Bearer ${token}`;
        opts.body = JSON.stringify({
          branchId: localBranchId,
          branchEmail,
          guestId,
          content: contentToRetry,
        });
      }

      // 4️⃣ Send with backoff
      const response = await fetchWithBackoff(url, opts);
      const data = await response.json();

      if (response.ok && data.savedMessage) {
        const saved = data.savedMessage;
        const confirmed = {
          ...saved,
          guestId,
          branchEmail,
          sender: "guest",
          status: "sent",
          pending: false,
          archived: false,
          message: saved.content || contentToRetry,
          content: saved.content || contentToRetry,
          tempId,
        };

        // Replace optimistic entry
        setMessages((prev) => {
          const u = [...prev];
          const idx = u.findIndex((m) => m.tempId === tempId);
          if (idx !== -1) u[idx] = confirmed;
          else u.push(confirmed);
          sessionStorage.setItem(
            `chatMessages-${guestId}`,
            JSON.stringify(u)
          );
          return u;
        });

        // 5️⃣ WebSocket emit
        sendMessage({
          room: `guest-${guestId.replace(/^guest-/, "")}`,
          guestId,
          branchEmail,
          content: confirmed.content,
          media: confirmed.media || null,
          sender: "guest",
          id: confirmed.id,
          timestamp: confirmed.timestamp,
        })
          .then((ack) => {
            console.log("[RETRY] 📡 WS ack:", ack);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === confirmed.id
                  ? { ...m, status: "delivered", pending: false }
                  : m
              )
            );
          })
          .catch((err) => {
            console.error("[RETRY] ❌ WS error:", err);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === confirmed.id
                  ? {
                      ...m,
                      status: "failed",
                      pending: true,
                      retry: () =>
                        retrySendMessage(contentToRetry, mediaToRetry),
                    }
                  : m
              )
            );
          });
      } else {
        console.error("[RETRY] ❌ API failed:", data);
        // mark entry failed
        setMessages((prev) => {
          const u = [...prev];
          const idx = u.findIndex((m) => m.tempId === tempId);
          if (idx !== -1) {
            u[idx] = {
              ...u[idx],
              status: "failed",
              pending: true,
              failureReason: data.error || "Retry failed",
              retry: () => retrySendMessage(contentToRetry, mediaToRetry),
            };
          }
          return u;
        });
      }
    } catch (err) {
      console.error("[RETRY] ❌ Unexpected error:", err);
      // fail entry
      setMessages((prev) => {
        const u = [...prev];
        const idx = u.findIndex((m) => m.tempId === tempId);
        if (idx !== -1) {
          u[idx] = {
            ...u[idx],
            status: "failed",
            pending: true,
            failureReason: err.message || "Unexpected error",
            retry: () => retrySendMessage(contentToRetry, mediaToRetry),
          };
        }
        return u;
      });
    }
  },
  [branchEmail, guestId, localBranchId, isConnected, media, previewFile]
);


useEffect(() => {
  const handleConnectionChange = (connected) => {
    setIsConnected(connected);
    console.log("[CHATBOX] ⚡ Connection status changed:", connected);

    if (connected) {
      // ✅ Retry failed messages
      setMessages((prev) => {
        const failedMessages = prev.filter((msg) => msg.status === "failed");
        failedMessages.forEach((msg) => {
          console.log("[RETRY] ⏳ Retrying failed message:", msg.content);
          retrySendMessage(msg.content, msg.media || null);
        });
        // Remove them from the list so we don’t retry twice
        return prev.filter((msg) => msg.status !== "failed");
      });
    }
  };

  const unsubscribe = onConnectionStatus((online) => {
  console.log("[GUEST] Connection status:", online);
  handleConnectionChange(online);
  });
  return unsubscribe;
}, [retrySendMessage]);

useEffect(() => {
  // Inline fetchChatHistory so it's not a dep
  const fetchChatHistory = async () => {
    try {
      setIsLoading(true);

      // 1️⃣ Try session cache first
      const cacheKey = `chatMessages-${guestId}`;
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        try {
          const arr = JSON.parse(cached);
          if (Array.isArray(arr) && arr.length) {
            console.log("[CHAT] 💾 Loaded from session cache");
            setMessages(arr);
          }
        } catch (err) {
          console.warn("[CHAT] ⚠️ Couldn’t parse cache:", err.message);
        }
      }

      // 2️⃣ Then fetch from API
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/api/messages/history/${guestId}`,
        { credentials: "include" }
      );
      const body = await res.json();

      if (res.ok) {
        // filter + normalize
        const normalized = body.messages
          .filter(m => m.branchId === localBranchId)
          .map(m => ({
            ...m,
            timestamp: m.timestamp
              ? new Date(m.timestamp).toISOString()
              : new Date().toISOString(),
          }));

        if (normalized.length) {
          setMessages(normalized);
          sessionStorage.setItem(cacheKey, JSON.stringify(normalized));
          console.log("[CHAT] ✅ History loaded & cached");
        } else {
          console.warn("[CHAT] ⚠️ No messages from API");
        }

        // mark seen on any unread branch-sent messages
        normalized
          .filter(m => m.sender === "branch" && m.status === "sent")
          .forEach(m => emitMessageSeen(guestId, m.id));
      } else {
        console.error("[CHAT] ❌ API error:", body.error);
        setError("Failed to load chat history. Please try again.");
      }
    } catch (err) {
      console.error("[CHAT] ❌ Unexpected error:", err.message);
      setError("An error occurred while loading chat history.");
    } finally {
      setIsLoading(false);
    }
  };

  // Hydrate branchId if missing
  if (!localBranchId) {
    const stored = sessionStorage.getItem("branchId");
    if (stored) {
      console.log("[GUEST] 📦 Hydrated branchId:", stored);
      setLocalBranchId(stored);
    } else {
      console.error("[GUEST] ❌ No branchId in props or storage");
      setError("Branch ID is missing. Cannot proceed.");
      return;
    }
  }

  // Guard missing inputs
  if (!branchEmail || !guestId) {
    console.error("[GUEST] ❌ Missing branchEmail or guestId");
    setError("Unable to connect to chat. Please try again later.");
    return;
  }

  // Default status
  setBranchStatus({ online: false, lastSeen: "Unknown" });

  // Load history on first render (detailsSubmitted flag)
  if (isDetailsSubmitted) {
    fetchChatHistory();
  }

  // ——— WebSocket handlers ———
  const handleIncomingMessage = msg => {
    // timestamp normalization
    if (!msg.timestamp) msg.timestamp = new Date().toISOString();
    else if (msg.timestamp.toDate) msg.timestamp = msg.timestamp.toDate().toISOString();

    if (msg.guestId !== guestId) return;

    const normalized = {
      ...msg,
      pending: false,
      message: msg.message || msg.content || "",
      content: msg.content || msg.message || "",
    };

    setMessages(prev => {
      const idx = prev.findIndex(
        m => m.pending && m.message === normalized.message && m.sender === "guest"
      );
      const next = [...prev];
      if (idx !== -1) next[idx] = normalized;
      else if (!next.find(m => m.id === normalized.id)) next.push(normalized);
      sessionStorage.setItem(`chatMessages-${guestId}`, JSON.stringify(next));
      return next;
    });

    if (normalized.sender === "branch" && document.visibilityState === "visible") {
      emitMessageSeen(guestId, normalized.id);
    }
  };

  const handleTyping = ({ room, sender, isTyping }) => {
    if (room === `guest-${guestId}` && sender === branchEmail) {
      setTypingIndicator(isTyping ? "Branch admin is typing..." : null);
    }
  };

  onNewMessage(handleIncomingMessage);
  onTyping(handleTyping);
  socket.on("connect", () => {
    console.log("[GUEST] 🔁 Reattached onNewMessage after reconnect");
    onNewMessage(handleIncomingMessage);
  });

  return () => {
    console.log("[GUEST] 🧹 Cleaning up GuestChatBox...");
    if (!sessionStorage.getItem("chatOpen")) {
      disconnectSocket(true, "manual");
    }
    offNewMessage(handleIncomingMessage);
    offTyping(handleTyping);
    if (socket.off) {
      socket.off("receiveMessage");
      socket.off("connect");
      socket.__messageListenerAttached = false;
    }
  };
}, [
  branchEmail,
  guestId,
  isDetailsSubmitted,
  localBranchId
]);

  // ── 0) Fetch current branch status once on mount ────────────────────
  useEffect(() => {
    if (!branchEmail) return;

    (async () => {
      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/branch-status?branchEmail=${encodeURIComponent(branchEmail)}`,
          { credentials: "include" }
        );
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const { online, lastSeen } = await res.json();
        setBranchStatus({
          online,
          lastSeen: lastSeen ? new Date(lastSeen).toLocaleString() : "Unknown",
        });
      } catch (err) {
        console.warn("[GUEST] Failed to fetch branch status:", err);
      }
    })();
  }, [branchEmail]);

// ── 1) Listen for branch status updates ─────────────────────────
useEffect(() => {
  if (!branchEmail) return;

  const handleBranchStatus = (status) => {
    if (
      status.branchEmail &&
      branchEmail &&
      status.branchEmail.toLowerCase() === branchEmail.toLowerCase()
    ) {
      console.debug("[GUEST] Socket branchStatus (debounced):", status);
      debouncedSetBranchStatus(status);
    }
  };

  onBranchStatus(handleBranchStatus);
  return () => {
    offBranchStatus(handleBranchStatus);
    // clear any pending debounce to avoid stray updates
    debouncedSetBranchStatus.cancel?.();
  };
}, [branchEmail, debouncedSetBranchStatus]);

// ── 2) Join the socket room when we become connected ─────────────
useEffect(() => {
  if (guestId && isConnected) {
    const guestRoom = `guest-${guestId.replace(/^guest-/, "")}`;
    socket.emit("joinRoom", guestRoom, () => {
      console.log("[GUEST] Joined guest room:", guestRoom);
    });
  }
}, [guestId, isConnected]);

  const updateLastPendingMessageAsFailed = (failureReason) => {
    setMessages((prev) => {
      const updated = [...prev];
      // Find the most recent message with pending true using lastIndexOf
      const pendingFlags = updated.map((m) => !!m.pending);
      const idx = pendingFlags.lastIndexOf(true);
      if (idx !== -1) {
        updated[idx] = {
          ...updated[idx],
          status: "failed",            // tag the message as failed
          pending: true,               // still pending since not delivered
          failureReason,               // optional: record the failure reason
          retry: () =>
            retrySendMessage(
              updated[idx].message || updated[idx].content,
              updated[idx].media || null
            ), // attach a retry function
        };
      }
      return updated;
    });
    setError(""); // Clear any global error if set
  };
  
  // ── Updated handleSendMessage ───────────────────────────────────────

const handleSendMessage = async (overrideMedia = null, overrideContent = null) => {

  if (!isConnected) {
  console.warn("[GUEST] ⚠️ Cannot send while offline");
  updateLastPendingMessageAsFailed("Cannot send while offline");
  return setIsLoading(false);
}

  // 0️⃣ ensure token won't expire mid‐send
  try {
    await ensureValidGuestToken();
  } catch (err) {
    console.warn("[GUEST] ⚠️ Proactive token refresh failed:", err.message);
  }

  // 1️⃣ determine mediaToSend, contentToSend …
  const isEvent =
    overrideMedia &&
    typeof overrideMedia === "object" &&
    overrideMedia.nativeEvent;
  const mediaToSend = !isEvent && overrideMedia !== null
    ? overrideMedia
    : media || previewFile;
  const contentToSend =
    overrideContent !== null ? overrideContent : message.trim();

  console.debug("[DEBUG] handleSendMessage → mediaToSend:", mediaToSend);
  console.debug("[DEBUG] handleSendMessage → contentToSend:", contentToSend);

  const sessionGuestId = sessionStorage.getItem("guestId");
  const effectiveGuestId = sessionGuestId || guestId;
  if (!localBranchId || !effectiveGuestId || !branchEmail) {
    console.error("[GUEST] ❌ Missing identifiers. Cannot send message.");
    updateLastPendingMessageAsFailed("Missing identifiers");
    return;
  }

  setIsLoading(true);

  // Optimistic UI message
  const tempId = generateTempId();
  const optimisticMessage = {
    guestId: effectiveGuestId,
    branchEmail,
    sender: "guest",
    content: contentToSend,
    message: contentToSend,
    timestamp: new Date().toISOString(),
    archived: false,
    pending: true,
    status: "sent",
    tempId,
    media: mediaToSend || null
  };
  setMessages(prev => [...prev, optimisticMessage]);

  // Prepare fetch options
  const token = sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken");
  const url = `${process.env.REACT_APP_API_URL}/api/messages/send`;
  let opts = {
    method: "POST",
    credentials: "include",
    headers: {},
    body: null
  };

  if (mediaToSend) {
    const form = new FormData();
    form.append("branchId", localBranchId);
    form.append("branchEmail", branchEmail);
    form.append("guestId", effectiveGuestId);
    form.append("content", contentToSend);
    form.append("media", mediaToSend);
    opts.body = form;
    if (token) opts.headers.Authorization = `Bearer ${token}`;
  } else {
    opts.headers["Content-Type"] = "application/json";
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    opts.body = JSON.stringify({
      branchId: localBranchId,
      branchEmail,
      guestId: effectiveGuestId,
      content: contentToSend
    });
  }

  try {
    // first attempt
    let response = await fetchWithBackoff(url, opts);

    // if unauthorized, refresh & retry once
    if (response.status === 401) {
      console.warn("[GUEST] ⚠️ Token expired, refreshing token and retrying...");
      if (!window.__CSRF_TOKEN__) await fetchCsrfToken();
        // ensure CSRF token present
        await fetch(`${process.env.REACT_APP_API_URL}/api/guest/refresh-token`, {
          method: "POST",
          credentials: "include",
          headers: { "X-CSRF-Token": window.__CSRF_TOKEN__ },
        });
      const newToken = sessionStorage.getItem("guestToken");
      if (!newToken) throw new Error("Unable to refresh guest token");
      opts.headers.Authorization = `Bearer ${newToken}`;
      response = await fetchWithBackoff(url, opts);
    }

    const data = await response.json();

    if (!response.ok || !data.savedMessage) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    // on success: replace optimistic with confirmed
    const saved = data.savedMessage;
    const confirmedMessage = {
      ...saved,
      guestId: effectiveGuestId,
      branchEmail,
      sender: "guest",
      status: "sent",
      pending: false,
      archived: false,
      content: saved.content || contentToSend,
      message: saved.content || contentToSend,
      tempId,
      media: saved.media || mediaToSend || null
    };

    setMessages(prev => {
      const arr = [...prev];
      const idx = arr.findIndex(m => m.tempId === tempId);
      if (idx > -1) arr[idx] = confirmedMessage;
      else arr.push(confirmedMessage);
      return arr;
    });

    // clear draft only on success
    setMessage("");
    setMedia(null);
    setPreviewFile(null);   
    if (inputFileRef.current) {
      inputFileRef.current.value = "";
    }

    // emit over WS
    const guestRoom = `guest-${effectiveGuestId.replace(/^guest-/, "")}`;
    sendMessage({
      room: guestRoom,
      guestId: effectiveGuestId,
      branchEmail,
      content: confirmedMessage.content,
      media: confirmedMessage.media,
      sender: "guest",
      id: confirmedMessage.id,
      timestamp: confirmedMessage.timestamp
    })
      .then(ack => {
        console.log("[SOCKET] 📡 WS ack for guest message:", ack);
        setMessages(prev =>
          prev.map(msg =>
            msg.id === confirmedMessage.id
              ? { ...msg, status: "delivered", pending: false }
              : msg
          )
        );
      })
      .catch(err => {
        console.error("[SOCKET] ❌ WS error:", err);
        setMessages(prev =>
          prev.map(msg =>
            msg.id === confirmedMessage.id
              ? {
                  ...msg,
                  status: "failed",
                  pending: true,
                  retry: () => retrySendMessage(msg.message, msg.media)
                }
              : msg
          )
        );
      });

    // broadcast to other tabs
    try {
      const bc = new BroadcastChannel("guest-chat");
      bc.postMessage({ type: "newMessage", payload: confirmedMessage });
      bc.close();
    } catch (e) {
      console.warn("[SYNC] BroadcastChannel emit failed:", e.message);
    }
  } catch (err) {
    console.error("[GUEST] ❌ sendMessage failed:", err.message);
    updateLastPendingMessageAsFailed(err.message);
  } finally {
    setIsLoading(false);
  }
};
   
  
  const formatLastSeen = (timestamp) => {
    if (!timestamp) return "Unknown";
    let date;
    if (timestamp.toDate) {
      date = timestamp.toDate();
    } else {
      date = new Date(timestamp);
    }
    return isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
  };

  /**
   * Handle closing the chat box
   */
  const handleChatClose = async () => {
  // 0️⃣ Proactively ensure our JWT is fresh before emitting chatClosed
  try {
    await ensureValidGuestToken();
  } catch (err) {
    console.warn("[CLIENT:GUEST] ⚠️ Proactive token refresh failed:", err.message);
    // we’ll still attempt to close, but server may reject if truly expired
  }

  try {
    console.log("[CLIENT:GUEST] 🚪 Closing chat for guestId:", guestId);
    setIsClosing(true);

    if (!guestId || !branchEmail) {
      console.error(
        "[CLIENT:GUEST] ❌ Cannot close chat. guestId or branchEmail missing."
      );
      return;
    }

    // 1️⃣ Archive messages in Firestore (fire-and-forget)
    (async () => {
      try {
        const messagesRef = collection(db, "messages");
        const messageQuery = query(
          messagesRef,
          where("guestId", "==", guestId),
          where("branchEmail", "==", branchEmail)
        );
        const snap = await getDocs(messageQuery);
        console.log(
          `[CLIENT:GUEST] 📦 Found ${snap.size} messages for guestId: ${guestId}`
        );
        if (!snap.empty) {
          const batch = writeBatch(db);
          snap.forEach((doc) => {
            console.log(`[CLIENT:GUEST] 📌 Archiving message ID: ${doc.id}`);
            batch.update(doc.ref, { archived: true });
          });
          await batch.commit();
          console.log(
            `[CLIENT:GUEST] ✅ Archived ${snap.size} messages for guestId: ${guestId}`
          );
        } else {
          console.warn(
            `[CLIENT:GUEST] ⚠️ No chat history for guestId: ${guestId}. Skipping archive.`
          );
        }
      } catch (e) {
        console.error("[CLIENT:GUEST] ❌ Archive error:", e.message);
      }
    })();

    // 2️⃣ & 3️⃣ Resolve token and canonicalise guestId
    const token =
      sessionStorage.getItem("guestToken") ||
      localStorage.getItem("guestToken") ||
      window.__FALLBACK_GUEST_TOKEN__;
    if (!token) {
      console.warn("[CLIENT:GUEST] ❌ Missing guest token for REST fallback");
    }
    const canonId = guestId
      .toLowerCase()
      .startsWith("guest-")
      ? guestId.toLowerCase()
      : `guest-${guestId.toLowerCase()}`;

    // 4️⃣ Prepare payload & REST-fallback helper
    const payload = { guestId: canonId, branchEmail };
    const doRestFallback = async () => {
      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/guest/force-close`,
          {
            method: "POST",
            credentials: "same-origin",               // include cookies if used
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,    // explicit JWT auth
            },
            body: JSON.stringify(payload),
          }
        );
        const data = await res.json();
      if (res.ok) {
        console.log("[CLIENT:GUEST] ✅ Fallback REST emit successful:", data);
      } else if (data.error === "No messages found.") {
        console.info("[CLIENT:GUEST] ℹ️ No prior messages to archive; chat close acknowledged.");
      } else {
        console.error("[CLIENT:GUEST] ❌ Fallback REST emit failed:", data.error);
      }
      } catch (err) {
        console.error("[CLIENT:GUEST] ❌ REST fallback error:", err.message);
      }
    };

    // ── Fix: if tab is hidden, skip socket emit & do REST immediately ──
    if (document.visibilityState === "hidden") {
      console.warn("[CLIENT:GUEST] 📴 Tab hidden — using immediate REST fallback");
      await doRestFallback();
    } else {
      // 5️⃣ WebSocket path (with reconnect on stale socket)
      if (socket && socket.connected) {
        socket.emit("chatClosed", payload);
        console.log("[CLIENT:GUEST] 📤 Sent chatClosed via socket");
      } else if (socket && !socket.connected && token) {
        console.warn(
          "[CLIENT:GUEST] ⏳ Reconnecting socket to emit chatClosed..."
        );
        socket.auth = { token, guestId: canonId, branchEmail };
        socket.once("connect", () => {
          console.log("[CLIENT:GUEST] 🔁 Reconnected — emitting chatClosed");
          socket.emit("chatClosed", payload);
        });
        try {
          socket.connect();
        } catch (err) {
          console.error("[CLIENT:GUEST] ❌ Reconnect failed:", err.message);
          socket.emit("chatClosed", payload);
        }
      } else {
        console.warn(
          "[CLIENT:GUEST] ⚠️ Socket disconnected — skipping socket emit"
        );
      }
      // Unconditional REST fallback after 3s
      setTimeout(doRestFallback, 3000);
    }
  } catch (err) {
    console.error(
      "[CLIENT:GUEST] ❌ Error during handleChatClose:",
      err.message
    );
  } finally {
    // 6️⃣ Manual disconnect + UI cleanup
    setTimeout(() => {
      disconnectSocket(false, "manual");
    }, 100);
    onClose();
  }
};


  /**
   * Handle typing input
   */
  const handleTyping = (e) => {
    setMessage(e.target.value);
    emitTyping(guestId, guestId, e.target.value.length > 0);
  };

  useEffect(() => {
    const onBeforeUnloadChatClose = () => {
      const guestId     = sessionStorage.getItem("guestId");
      const branchEmail = sessionStorage.getItem("branchEmail");
      const token       = sessionStorage.getItem("guestToken");
  
      if (!guestId || !branchEmail) {
        console.warn(
          "[GUEST] ❌ Missing guestId or branchEmail — skipping unload handler."
        );
        return;
      }
  
      try {
        // Build URL with token fallback
        const url = new URL(
          `${process.env.REACT_APP_API_URL}/api/guest/force-close`
        );
        if (token) url.searchParams.set("token", token);
  
        // Payload for archiving + chatClosed emit
        const payload = JSON.stringify({ guestId, branchEmail });
        navigator.sendBeacon(
          url.toString(),
          new Blob([payload], { type: "application/json" })
        );
  
        console.log("[GUEST] 📡 Beacon sent to force-close API.");
      } catch (err) {
        console.warn("[GUEST] ❌ Beacon failed:", err.message);
      }
  
      // Tiny spin to help delivery
      const waitUntil = performance.now() + 50;
      while (performance.now() < waitUntil);
    };
  
    window.addEventListener("beforeunload", onBeforeUnloadChatClose);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnloadChatClose);
    };
  }, []);  

  return (
  <>
    {/* Minimized Chat Widget */}
    {isMinimized ? (
      <div className="chat-widget" onClick={() => setIsMinimized(false)}>
        <span
          className={`status-dot ${branchStatus.online ? "online" : "offline"}`}
        />
        <span>Chat with {branchName || "Support"}</span>
      </div>
    ) : (
      <div className="guest-chat-box">
        {/* Header */}
        <div className="guest-chat-box-header flex items-center justify-between">
          <div className="flex items-center">
            <h2 className="flex items-center space-x-2">
              <span>Chat with {branchName || "Support"}</span>
              {!isConnected ? (
                // When our network is down, we just show Unavailable
                <span className="text-gray-500 text-sm">Unavailable</span>
              ) : branchStatus.online ? (
                <span className="text-green-500 font-bold">Active Now</span>
              ) : (
                <span className="text-gray-500 text-sm">
                  Offline – Last Active:{" "}
                  {branchStatus.lastSeen && branchStatus.lastSeen !== "Unknown"
                    ? formatLastSeen(branchStatus.lastSeen)
                    : "Unavailable"}
                </span>
              )}
            </h2>

            {/* Network quality badge – only when connected */}
            {isConnected && (
              <div
                className="network-indicator ml-4 flex items-center text-xs px-2 py-1 cursor-pointer"
                onClick={() => setShowNetworkModal(true)}
                aria-label="Network optimizations info"
              >
                <span>{networkType.toUpperCase()}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              className="minimize-chat-btn"
              onClick={() => setIsMinimized(true)}
              title="Minimize chat"
            >
              🔽
            </button>
            <button
              className="close-chat-btn"
              onClick={() => {
                if (
                  messages.length === 0 ||
                  window.confirm(
                    "Closing this will require a new conversation. Are you sure?"
                  )
                ) {
                  handleChatClose();
                }
              }}
            >
              ❌
            </button>
          </div>
        </div>

        {/* Success message after download/send */}
        {transcriptSuccessMsg && (
          <div className="bg-green-100 text-green-700 text-sm px-4 py-2 border border-green-300 rounded mx-4 my-2">
            {transcriptSuccessMsg}
          </div>
        )}

        {/* Offline Banner */}
        {!isConnected && (
          <div className="bg-red-100 text-red-700 text-center py-2 px-4 border-b border-red-300">
            ⚠️ You are currently offline. Trying to reconnect...
          </div>
        )}

        {/* Chat Content */}
        <div className="guest-chat-box-content">
          {error && (
            <p className="error-message text-red-500 font-semibold text-sm mb-2">
              {error}
            </p>
          )}

          {messages.map((msg, idx) => {
            const ts = new Date(msg.timestamp);
            const formattedTime = ts.toLocaleString("en-US", {
              month: "short",
              day: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            });

            return (
              <div
                key={msg.id || msg.tempId || idx}
                className={`message-wrapper mb-4 ${msg.sender}`}
              >
                <MessageItem
                  message={msg}
                  sender={msg.sender}
                  hideMedia={false}
                />

                <div
                  className="message-timestamp mt-1"
                  style={{
                    alignSelf:
                      msg.sender === "guest" ? "flex-end" : "flex-start",
                  }}
                >
                  {formattedTime}
                </div>

                {/* Retry button for failed messages */}
                {msg.status === "failed" && (
                  <button
                    className="retry-btn text-blue-500 underline text-sm mt-1"
                    onClick={() =>
                      retrySendMessage(msg.content, msg.media || null)
                    }
                  >
                    Retry
                  </button>
                )}
              </div>
            );
          })}

          {isLoading && (
            <p className="sending-message-label italic text-xs mt-1">
              Sending message...
            </p>
          )}

          {typingIndicator && (
            <p className="typing-indicator">{typingIndicator}</p>
          )}
        </div>

        {/* Footer: Image preview + toolbar */}
        <div className="guest-chat-box-footer bg-white border-t px-4 py-3">
          {/* 1) Preview Thumbnail row – only when an image is selected */}
          {previewFile && (
            <div className="flex justify-center mb-3">
              <div className="relative w-16 h-16">
                <img
                  src={URL.createObjectURL(previewFile)}
                  alt="Attachment preview"
                  disabled={!isConnected}
                  className="w-full h-full object-cover rounded border"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPreviewFile(null);
                    inputFileRef.current.value = "";
                  }}
                  className="absolute -top-1 -right-1 bg-gray-800 bg-opacity-75 text-white rounded-full p-0.5 text-xs"
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* 2) Main toolbar row */}
          <div className="flex items-center flex-wrap space-x-2">
            {/* Attach image */}
            <label
              className={`flex-shrink-0 p-2 rounded ${!isConnected ? "opacity-30 cursor-not-allowed" : "hover:bg-gray-100 cursor-pointer"}`}
              title="Attach image"
              onClick={!isConnected ? (e) => e.preventDefault() : undefined}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-6 h-6 text-gray-600"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm0 2h12v6l-3-3-3 4-3-4-3 4V5z"
                  clipRule="evenodd"
                />
              </svg>
              <input
                type="file"
                accept="image/*"
                ref={inputFileRef}
                disabled={!isConnected}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setPreviewFile(file);
                }}
              />
            </label>

            {/* Email transcript (no blue background) */}
            <button
              type="button"
              onClick={() => setShowTranscriptModal(true)}
              title="Send Email"
              className="email-icon p-2 rounded hover:bg-gray-100 focus:outline-none"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-6 h-6"
                fill="#4B5563"
                viewBox="0 0 24 24"
                stroke="none"
              >
                <path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 2l-8 5-8-5h16zm0 12H4V8l8 5 8-5v10z" />
              </svg>
            </button>

            {/* Message input */}
            <input
              type="text"
              value={message}
              onChange={handleTyping}
              disabled={!isConnected}
              placeholder={
                previewFile ? "Enter caption for this image" : "Type a message..."
              }
              className={`flex-1 min-w-0 h-10 px-3 border rounded-lg focus:outline-none ${!isConnected ? "bg-gray-100" : ""}`}
            />

            {/* Send button */}
            <button
              onClick={handleSendMessage}
              disabled={
                isLoading ||
                (!message.trim() && !previewFile && !media) ||
                !isConnected
              }
              className="flex-shrink-0 h-10 px-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Send message"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Network Info Modal */}
    {showNetworkModal && (
      <div
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]"
        onClick={() => setShowNetworkModal(false)}
      >
        <div
          className="bg-white rounded-lg p-6 max-w-sm text-center"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-gray-800">
            Different optimizations for this chat box will apply based on your network speed
          </p>
          <button
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            onClick={() => setShowNetworkModal(false)}
          >
            OK
          </button>
        </div>
      </div>
    )}

    {/* Transcript Modal */}
    <TranscriptModal
      isOpen={showTranscriptModal}
      onClose={() => setShowTranscriptModal(false)}
      branchEmail={branchEmail}
      branchName={branchName}
      guestId={guestId}
    />
  </>
);
};
export default GuestChatBox;