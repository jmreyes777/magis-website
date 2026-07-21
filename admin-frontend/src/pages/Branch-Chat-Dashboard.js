import React, {
  useContext,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import AuthContext from "../context/AuthContext";
import {
  startHeartbeat,
  onNewMessage,
  socketInstance,
  onSocketConnected,
  onSocketDisconnected,
  isTokenExpired,
  sendMessage,
  connectSocket,
  onUnreadUpdate,
  emitTyping,
  offTyping,
  onTyping,
  isHeartbeatActive,
} from "../components/Admin-Utils-socket";
import AdminMessageItem from "../components/Admin-Message-Item-Component";
import AdminNavigation from "../components/AdminNavigation-Component";
import AdminHeaderWidgets, {
  unreadStorageKey,
} from "../components/AdminHeaderWidgets-Component";
import ConnectionStatus from "../components/ConnectionStatus-Component";
import { ensureSessionHydrated } from "../utils/sessionHydration";
import { db, storage } from "../firebase-config";
import {
  collection,
  query,
  where,
  getDoc,
  getDocs,
  doc,
  addDoc,
  orderBy,
  updateDoc,
  serverTimestamp,
  onSnapshot,
  limit,
  writeBatch,
} from "firebase/firestore";
import { useLocation, useNavigate } from "react-router-dom";
import { waitForCustomClaims } from "../utils/waitForCustomClaims";
import { optimizeImage } from "../utils/imageOptimization";
import { useWakeLock } from "../utils/useWakeLock";
import "./Branch-Chat-Dashboard.css";
import MFASessionModal from "../components/MFASessionModal";
import {
  isE2EEEstablished,
  e2eeEncrypt,
  e2eeDecrypt,
  establishWithServerKey,
} from "../utils/e2eeCrypto";

// ============================================================================
// CONSTANTS
// ============================================================================

const LOCAL_STORAGE_VERSION = "1";
const MAX_RETRIES = 5;
const BACKOFF_MS = 1000;
const BROADCAST_INTERVAL_MS = 5000;
const TYPING_DEBOUNCE_MS = 1000;
const STORAGE_DEBOUNCE_MS = 300;
const REBIND_DEBOUNCE_MS = 200;
const MESSAGE_HYDRATION_DEBOUNCE_MS = 3000;
const CHAT_QUERY_LIMIT = 100;
const MESSAGE_QUERY_LIMIT = 100;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Exponential-backoff fetch on 429 errors
 */
async function fetchWithBackoff(url, options, maxRetries = MAX_RETRIES, backoffMs = BACKOFF_MS) {
  let tries = 0,
    delay = backoffMs;
  while (true) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    if (tries >= maxRetries) throw new Error("Rate limit exceeded");
    await new Promise((r) => setTimeout(r, delay));
    tries++;
    delay *= 2;
  }
}

/**
 * Canonical guest ID formatter - always returns "guest-<id>" in lowercase
 */
const canon = (id = "") =>
  id.toLowerCase().startsWith("guest-") ? id.toLowerCase() : `guest-${id.toLowerCase()}`;

/**
 * Normalize guest ID - removes "guest-" prefix and trims
 */
const normalizeGuestId = (id) => {
  if (!id) return "";
  return id.toLowerCase().replace(/^guest-/, "").trim();
};

// ============================================================================
// E2EE OUTGOING PLAINTEXT CACHE
// ----------------------------------------------------------------------------
// The E2EE shared key is ephemeral and per-tab (see utils/e2eeCrypto.js), while
// Firestore only stores ciphertext. That means a re-fetch of the thread (e.g.
// after switching browser tabs, a reconnect, or on a tab that never performed
// the key handshake) cannot always decrypt the admin's OWN sent messages, and
// the thread reverts to ciphertext/placeholder.
//
// Since the sender always knows the plaintext it typed, we cache outgoing
// plaintext keyed by the server message id and prefer it in every render path.
// sessionStorage keeps it per-tab and clears it on tab close to limit at-rest
// exposure of SPI under DPA 2012.
// ============================================================================
const E2EE_PLAINTEXT_CACHE_KEY = "e2eeOutgoingPlaintext";

const readPlaintextCache = () => {
  try {
    return JSON.parse(sessionStorage.getItem(E2EE_PLAINTEXT_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
};

const cacheOutgoingPlaintext = (id, plaintext) => {
  if (!id || typeof plaintext !== "string") return;
  try {
    const cache = readPlaintextCache();
    cache[id] = plaintext;
    sessionStorage.setItem(E2EE_PLAINTEXT_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* sessionStorage unavailable/full — non-fatal */
  }
};

const getCachedPlaintext = (id) => {
  if (!id) return null;
  const cache = readPlaintextCache();
  return Object.prototype.hasOwnProperty.call(cache, id) ? cache[id] : null;
};

// Detect an E2EE payload by SHAPE, not just the stored `e2ee` flag. Admin
// replies were historically persisted with the ciphertext as `content` but
// WITHOUT the e2ee flag, so flag-only checks skipped them and they rendered
// "[Encrypted message]" on reload. Returns the parsed {ciphertext, iv} or null.
const parseEncryptedPayload = (content) => {
  if (typeof content !== "string" || !content.includes('"ciphertext"')) return null;
  try {
    const p = JSON.parse(content);
    return p && p.ciphertext && p.iv ? p : null;
  } catch {
    return null;
  }
};

// ============================================================================
// MESSAGE SENDING HELPERS
// ============================================================================

/**
 * Create optimistic message object
 */
const createOptimisticMessage = (guestId, branchEmail, content, media = null) => ({
  guestId,
  branchEmail,
  sender: "branch",
  content,
  message: content,
  // Local blob preview so the image shows in the thread immediately; the
  // confirmed server message swaps in the private storage `path` (P1-3).
  media,
  timestamp: new Date().toISOString(),
  archived: false,
  pending: true,
  status: "sent",
  tempId: "temp-" + Date.now(),
});

/**
 * Build fetch options for message sending
 */
const buildMessageFetchOptions = (token, guestId, content, media, isEncrypted = false, encryptionMeta = null) => {
  const options = {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
    body: null,
  };

  if (media) {
    const formData = new FormData();
    formData.append("guestId", guestId);
    formData.append("content", content);
    formData.append("media", media);
    if (isEncrypted) {
      formData.append("e2ee", "true");
      formData.append("encryptionMeta", JSON.stringify(encryptionMeta));
    }
    options.body = formData;
  } else {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({ 
      guestId, 
      content,
      e2ee: isEncrypted,
      encryptionMeta: encryptionMeta,
    });
  }

  return options;
};

/**
 * Create confirmed message object from server response
 */
const createConfirmedMessage = (savedReply, guestId, branchEmail, tempId) => ({
  ...savedReply,
  guestId,
  branchEmail,
  sender: "branch",
  status: "sent",
  pending: false,
  archived: false,
  message: savedReply.content || savedReply.content,
  content: savedReply.content || savedReply.content,
  tempId,
});

/**
 * Build chat entries from message snapshot
 */
const buildChatEntriesFromMessages = (snapshot) => {
  const messagesByGuest = {};
  snapshot.forEach((doc) => {
    const msg = doc.data();
    if (msg.archived === true) return;

    if (!messagesByGuest[msg.guestId]) {
      // Never show raw E2EE ciphertext in the sidebar preview. The live preview
      // is updated with decrypted text by handleIncomingMessage when available.
      const isEncrypted =
        msg.e2ee ||
        (typeof msg.content === "string" && msg.content.includes('"ciphertext"'));
      // Retain the raw ciphertext so the preview can be decrypted asynchronously
      // once the per-conversation key is available (see preview-decryption effect).
      const encPreview =
        isEncrypted && typeof msg.content === "string" && msg.content.includes('"ciphertext"')
          ? msg.content
          : null;
      messagesByGuest[msg.guestId] = {
        guestId: msg.guestId,
        guestName: msg.guestName || `Guest ${msg.guestId.slice(-4)}`,
        lastMessage: isEncrypted ? "[Encrypted message]" : (msg.content || "[media]"),
        encPreview,
        timestamp: msg.timestamp,
        archived: false,
      };
    }
  });
  return Object.values(messagesByGuest);
};

/**
 * Merge hydrated chats into existing state
 */
const mergeChatsIntoState = (prevChats, hydratedChats) => {
  const merged = [...prevChats];
  const prevIndex = (guestId) => merged.findIndex((c) => c.guestId === guestId);

  hydratedChats.forEach((chat) => {
    const idx = prevIndex(chat.guestId);
    if (idx === -1) {
      merged.push(chat);
    } else {
      merged[idx] = chat;
    }
  });
  return merged;
};

/**
 * Update or create chat row in state
 */
const updateChatRow = (chats, guestId, row) => {
  const i = chats.findIndex((c) => c.guestId === guestId);
  if (i === -1) {
    return [...chats, row];
  } else {
    const next = [...chats];
    next[i] = { ...chats[i], ...row };
    return next;
  }
};

/**
 * Handle unread count logic
 */
const handleUnreadCount = (
  guestId,
  selectedId,
  sender,
  setUnreadCounts,
  setLastReadTimestamps
) => {
  if (sender !== "guest") return null;

  if (guestId === selectedId) {
    setUnreadCounts((prev) => ({ ...prev, [guestId]: 0 }));
    setLastReadTimestamps((prev) => {
      const next = { ...prev, [guestId]: Date.now() };
      localStorage.setItem("lastReadTimestamps", JSON.stringify(next));
      return next;
    });
  } else {
    setUnreadCounts((prev) => ({
      ...prev,
      [guestId]: (prev[guestId] || 0) + 1,
    }));
  }
};

/**
 * Persist chat state to localStorage
 */
const persistChatState = (branchEmail, chats) => {
  // A1: `activeGuestIds` is live / server-authoritative and is intentionally NOT
  // persisted — restoring presence from localStorage resurrects "ghost" guests
  // (R2/B2). Only chat previews are cached for instant paint; presence always comes
  // from the live guestPresenceUpdate feed.
  clearTimeout(window.__CHAT_STORAGE_DEBOUNCE__);
  window.__CHAT_STORAGE_DEBOUNCE__ = setTimeout(() => {
    localStorage.setItem(
      `branchChats-${branchEmail}`,
      JSON.stringify({
        version: LOCAL_STORAGE_VERSION,
        chats,
        activeGuestIds: [],
      })
    );
  }, STORAGE_DEBOUNCE_MS);
};

const BranchChatDashboard = () => {
  // ============================================================================
  // CONTEXT & NAVIGATION
  // ============================================================================
  const {
    isAuthenticated,
    isInitialized,
    fallbackHydrationComplete,
    sessionHydrated,
    firebaseAuthReady,
    handleLogout,
    branchSession: { id: branchId, email: rawBranchEmail, name: branchName },
    // MFA from context
    mfaEnrolled,
    mfaVerified,
    mfaRequired,
    checkMFAStatus,
    completeMFAVerification,
  } = useContext(AuthContext);
  // 🔑 enforce single canonical e-mail everywhere in the dashboard
  const branchEmail = (rawBranchEmail || "").toLowerCase().trim();

  const navigate = useNavigate();

  // ============================================================================
  // STATE
  // ============================================================================
  const [chats, setChats] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [newMessage, setNewMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [typingIndicator, setTypingIndicator] = useState(null);
  const [readyOnce, setReadyOnce] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [closedChats, setClosedChats] = useState({});
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [lastReadTimestamps, setLastReadTimestamps] = useState({});
  const [media, setMedia] = useState(null);
  const [isOptimizingImage, setIsOptimizingImage] = useState(false);
  // Blob preview URL for the composer chip. Created ONCE per attached file and
  // revoked on change/unmount — a render-time URL.createObjectURL(media) would
  // leak a new blob: URL on every re-render of this (very chatty) page and
  // throw inside render if `media` were ever not a Blob (→ error boundary).
  const mediaPreviewUrl = useMemo(() => {
    if (!media || typeof Blob === "undefined" || !(media instanceof Blob)) return null;
    try {
      return URL.createObjectURL(media);
    } catch {
      return null;
    }
  }, [media]);
  useEffect(() => {
    return () => {
      if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
    };
  }, [mediaPreviewUrl]);
  const [activeGuestIds, setActiveGuestIds] = useState(new Set());
  // D-1: presence is live/server-authoritative. `presenceReady` flips true the
  // first time an authoritative guestPresenceUpdate is applied; until then a brief
  // "syncing…" sidebar skeleton (gated >200ms) avoids painting stale/empty state on
  // cold load — we never render unconfirmed rows.
  const [presenceReady, setPresenceReady] = useState(false);
  const [showSyncing, setShowSyncing] = useState(false);

  // E2EE state per guest
  const [e2eeStatus, setE2eeStatus] = useState({}); // { guestId: "initializing" | "exchanging" | "established" | "failed" }
  const [e2eeErrors, setE2eeErrors] = useState({}); // { guestId: errorMessage }

  // MFA Session State (works with Firebase MFA)
  const [showMFASession, setShowMFASession] = useState(false);
  const [mfaSessionChecked, setMfaSessionChecked] = useState(false);

  // Transcript/inquiry inbox retired; activeTab retained for the chat-view layout.
  const [activeTab] = useState("chats");
  const chatMessagesRef = useRef(null);

  // ============================================================================
  // REFS
  // ============================================================================
  const selectedGuestRoomRef = useRef(null);
  const inputFileRef = useRef(null);
  const selectedChatRef = useRef(null);
  const chatsRef = useRef([]);
  const activeIdsRef = useRef(new Set());
  const lastProcessedMessageIdRef = useRef(null);
  const isExternalUpdateRef = useRef(false);
  const lastSyncHashRef = useRef("");
  const typingTimeout = useRef(null);
  const lastMessageHydration = useRef(0);

  // BroadcastChannel refs (per-branch)
  const adminSyncRef = useRef(null);
  const chatChannelRef = useRef(null);

  // ============================================================================  
  // BROADCAST CHANNEL HELPERS
  // ============================================================================
  const getAdminSyncChannel = useCallback(() => {
    const expectedName = `admin-sync:${branchEmail || "unknown"}`;
    if (adminSyncRef.current?.__name !== expectedName) {
      try {
        adminSyncRef.current?.close?.();
      } catch {}
      const ch = new BroadcastChannel(expectedName);
      ch.__name = expectedName;
      adminSyncRef.current = ch;
    }
    return adminSyncRef.current;
  }, [branchEmail]);

  const getChatChannel = useCallback(() => {
    const expectedName = `admin-chat:${branchEmail || "unknown"}`;
    if (chatChannelRef.current?.__name !== expectedName) {
      try {
        chatChannelRef.current?.close?.();
      } catch {}
      const ch = new BroadcastChannel(expectedName);
      ch.__name = expectedName;
      chatChannelRef.current = ch;
    }
    return chatChannelRef.current;
  }, [branchEmail]);

  // ============================================================================
  // COMPUTED VALUES
  // ============================================================================
  const sortedActiveChats = useMemo(() => {
    return chats
      .filter((chat) => !chat.archived && activeGuestIds.has(chat.guestId))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }, [chats, activeGuestIds]);

  // ============================================================================
  // TYPING INDICATOR EFFECTS
  // ============================================================================
  useEffect(() => {
    setTypingIndicator(null);
    selectedGuestRoomRef.current = selectedChat?.guestId
      ? `guest-${selectedChat.guestId}`
      : null;
  }, [selectedChat]);

  useEffect(() => {
    const handleIncomingTyping = ({ sender, isTyping, guestRoom }) => {
      if (guestRoom !== selectedGuestRoomRef.current) return;
      setTypingIndicator(isTyping ? "Guest is typing..." : null);
    };

    onTyping(handleIncomingTyping);
    return () => {
      offTyping(handleIncomingTyping);
    };
  }, []);

  // ============================================================================
  // E2EE: ESTABLISH VIA SERVER-MANAGED CONVERSATION KEY
  // ----------------------------------------------------------------------------
  // Instead of an ephemeral ECDH handshake (which required the guest to be online
  // and broke history after a tab close/reload), we fetch the per-conversation
  // AES-256 key from the backend (scoped to this branch). This establishes the
  // secure channel immediately — even when the guest is offline — so the admin
  // can always decrypt the conversation, including full history. The fetched key
  // feeds the existing AES-GCM e2eeEncrypt/e2eeDecrypt paths unchanged.
  // ============================================================================
  // Fetch (creating on first call) the per-conversation AES key for a guest and
  // import it into the local keyStore under the canonical guestId. Returns true
  // when the secure channel is ready. Shared by the selected-chat effect and the
  // sidebar preview-decryption effect.
  const ensureConversationKey = useCallback(
    async (guestId) => {
      if (!guestId || !branchEmail) return false;
      const gidKey = canon(guestId);
      if (isE2EEEstablished(gidKey)) return true;
      const token =
        sessionStorage.getItem("branchAdminToken") ||
        localStorage.getItem("branchAdminToken");
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/api/messages/conversation-key/${encodeURIComponent(guestId)}`,
        {
          method: "GET",
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) throw new Error(`conversation-key fetch failed (${res.status})`);
      const { key } = await res.json();
      if (!key) throw new Error("no conversation key returned");
      await establishWithServerKey(gidKey, key);
      return true;
    },
    [branchEmail]
  );

  useEffect(() => {
    const guestId = selectedChat?.guestId;
    if (!guestId || !branchEmail) return;
    if (isE2EEEstablished(canon(guestId))) {
      setE2eeStatus((prev) =>
        prev[guestId] === "established" ? prev : { ...prev, [guestId]: "established" }
      );
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setE2eeStatus((prev) => ({ ...prev, [guestId]: prev[guestId] || "initializing" }));
        await ensureConversationKey(guestId);
        if (cancelled) return;
        setE2eeStatus((prev) => ({ ...prev, [guestId]: "established" }));
        console.log(`[E2EE] Conversation key established for ${guestId}`);
      } catch (error) {
        if (cancelled) return;
        console.error(`[E2EE] Conversation key fetch failed for ${guestId}:`, error.message);
        setE2eeStatus((prev) => ({ ...prev, [guestId]: "failed" }));
        setE2eeErrors((prev) => ({ ...prev, [guestId]: error.message }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedChat?.guestId, branchEmail, ensureConversationKey]);

  // ============================================================================
  // E2EE: DECRYPT SIDEBAR LAST-MESSAGE PREVIEW
  // ----------------------------------------------------------------------------
  // Chat rows for encrypted conversations carry the raw ciphertext (`encPreview`)
  // and show "[Encrypted message]" until decrypted. Here we fetch the conversation
  // key on demand and replace the placeholder with plaintext. Rows whose key fetch
  // fails are remembered so we don't hammer the backend; they still decrypt via the
  // normal paths once the chat is opened.
  // ============================================================================
  const previewInFlightRef = useRef(new Set());
  const previewFailedRef = useRef(new Set());
  useEffect(() => {
    if (!branchEmail) return;
    const pending = chats.filter(
      (c) =>
        c &&
        c.encPreview &&
        c.lastMessage === "[Encrypted message]" &&
        !previewInFlightRef.current.has(c.guestId) &&
        !previewFailedRef.current.has(c.guestId)
    );
    if (pending.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const c of pending) {
        previewInFlightRef.current.add(c.guestId);
        try {
          const gidKey = canon(c.guestId);
          await ensureConversationKey(c.guestId);
          if (cancelled) return;
          const payload = JSON.parse(c.encPreview);
          if (!payload?.ciphertext || !payload?.iv) continue;
          const plain = await e2eeDecrypt(gidKey, payload.ciphertext, payload.iv);
          if (cancelled) return;
          if (typeof plain === "string") {
            setChats((prev) =>
              updateChatRow(prev, c.guestId, { lastMessage: plain, encPreview: null })
            );
          }
        } catch (err) {
          previewFailedRef.current.add(c.guestId);
        } finally {
          previewInFlightRef.current.delete(c.guestId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chats, branchEmail, ensureConversationKey]);

  // ============================================================================
  // SECURITY: COPY/PASTE PROTECTION (DLP Controls)
  // ============================================================================
  useEffect(() => {
    if (!selectedChat) return;

    const chatContainer = chatMessagesRef.current;
    if (!chatContainer) return;

    // Prevent copy event
    const handleCopy = (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Show warning toast
      const toast = document.createElement('div');
      toast.className = 'fixed top-4 right-4 bg-red-500 text-white px-4 py-2 rounded shadow-lg z-50 text-sm';
      toast.textContent = '⚠️ Copying chat content is disabled for data security';
      document.body.appendChild(toast);
      
      setTimeout(() => {
        toast.remove();
      }, 3000);
      
      console.warn('[DLP] Copy attempt blocked');
      return false;
    };

    // Prevent cut event
    const handleCut = (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.warn('[DLP] Cut attempt blocked');
      return false;
    };

    // Block keyboard shortcuts
    const handleKeyDown = (e) => {
      // Ctrl+C, Cmd+C
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        handleCopy(e);
        return false;
      }
      
      // Ctrl+X, Cmd+X
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault();
        handleCut(e);
        return false;
      }
      
      // Ctrl+A (select all) - prevent selecting all messages
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // Only block if focus is in chat container
        if (chatContainer.contains(document.activeElement)) {
          e.preventDefault();
          return false;
        }
      }
      
      // Print Screen
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        console.warn('[DLP] Screenshot attempt detected');
        
        // Blur the content briefly
        chatContainer.style.filter = 'blur(5px)';
        setTimeout(() => {
          chatContainer.style.filter = '';
        }, 1000);
        
        return false;
      }
    };

    // Prevent right-click context menu
    const handleContextMenu = (e) => {
      // Allow context menu only on input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
      }
      e.preventDefault();
      return false;
    };

    // Prevent drag and drop
    const handleDragStart = (e) => {
      e.preventDefault();
      return false;
    };

    // Add event listeners
    chatContainer.addEventListener('copy', handleCopy, true);
    chatContainer.addEventListener('cut', handleCut, true);
    chatContainer.addEventListener('keydown', handleKeyDown, true);
    chatContainer.addEventListener('contextmenu', handleContextMenu, true);
    chatContainer.addEventListener('dragstart', handleDragStart, true);

    // Also add to document level for keyboard shortcuts
    document.addEventListener('keydown', handleKeyDown, true);

    console.log('[DLP] Copy/paste protection enabled for chat');

    return () => {
      chatContainer.removeEventListener('copy', handleCopy, true);
      chatContainer.removeEventListener('cut', handleCut, true);
      chatContainer.removeEventListener('keydown', handleKeyDown, true);
      chatContainer.removeEventListener('contextmenu', handleContextMenu, true);
      chatContainer.removeEventListener('dragstart', handleDragStart, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      console.log('[DLP] Copy/paste protection disabled');
    };
  }, [selectedChat]);

  // ============================================================================
  // MFA SESSION CHECK ON MOUNT
  // Works with Firebase MFA - checks if session-level MFA verification is needed
  // ============================================================================
  useEffect(() => {
    if (!isAuthenticated || !branchEmail || mfaSessionChecked) return;
    
    const checkMFASession = async () => {
      try {
        const token = sessionStorage.getItem('branchAdminToken') || 
                     localStorage.getItem('branchAdminToken');
        
        if (!token) return;
        
        const sessionId = sessionStorage.getItem('mfaSessionId') || 
                         `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem('mfaSessionId', sessionId);
        
        const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/session-status`, {
          headers: { 
            Authorization: `Bearer ${token}`,
            'X-Session-Id': sessionId,
          },
          credentials: 'include',
        });
        
        // If the status check itself failed (e.g. 500), do NOT eject the admin.
        // Treat it as a soft pass so a transient backend error can't bounce a
        // legitimately-logged-in user out of the dashboard.
        if (!res.ok) {
          console.warn(`[MFA] session-status returned ${res.status} — skipping MFA gate (soft pass)`);
          setMfaSessionChecked(true);
          return;
        }

        const data = await res.json();
        
        if (!data.enrolled) {
          // MFA not enrolled - prompt session re-verification rather than navigating
          // to a non-existent route. (There is no /profile route in this app.)
          console.warn('[MFA] Not enrolled per server — prompting session verification');
          setShowMFASession(true);
        } else if (!data.verified) {
          // MFA enrolled but session not verified - show session modal
          console.info('[MFA] Session verification required');
          setShowMFASession(true);
        } else {
          // MFA verified - update context
          if (completeMFAVerification) {
            completeMFAVerification();
          }
        }
        
        setMfaSessionChecked(true);
      } catch (error) {
        console.error('[MFA Session] Error checking:', error);
        setMfaSessionChecked(true);
      }
    };
    
    checkMFASession();
  }, [isAuthenticated, branchEmail, mfaSessionChecked, navigate, completeMFAVerification]);

  // ============================================================================
  // MFA SESSION RE-CHECK (mid-session)
  // Periodically re-validates the session so a geolocation anomaly (international
  // IP change) detected by the backend re-opens the MFA modal without a reload.
  // ============================================================================
  useEffect(() => {
    if (!isAuthenticated || !branchEmail) return;

    const recheckSession = async () => {
      try {
        const token = sessionStorage.getItem('branchAdminToken') ||
                     localStorage.getItem('branchAdminToken');
        if (!token) return;

        const sessionId = sessionStorage.getItem('mfaSessionId');
        if (!sessionId) return;

        const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/session-status`, {
          headers: { Authorization: `Bearer ${token}`, 'X-Session-Id': sessionId },
          credentials: 'include',
        });
        if (!res.ok) return; // soft pass on transient errors

        const data = await res.json();
        if (data.geoAnomaly || (data.enrolled && !data.verified)) {
          if (data.geoAnomaly) {
            console.warn('[MFA] 🌍 Geolocation anomaly detected mid-session — re-verification required');
          }
          setShowMFASession(true);
        }
      } catch (e) {
        // ignore transient errors; do not eject the admin
      }
    };

    const intervalId = setInterval(recheckSession, 60 * 1000); // every 60s
    return () => clearInterval(intervalId);
  }, [isAuthenticated, branchEmail]);

  // ============================================================================
  // UNREAD COUNTS & READ TIMESTAMP EFFECTS
  // ============================================================================
  useEffect(() => {
    const saved = localStorage.getItem("lastReadTimestamps");
    if (saved) {
      setLastReadTimestamps(JSON.parse(saved));
    }
  }, []);

  // Hydrate unread counts from the per-branch snapshot so navigating to
  // another admin page and back doesn't zero the waiting-guests state.
  // Live values (server pushes that raced ahead of hydration) win the merge.
  const unreadInitialRef = useRef(null);
  useEffect(() => {
    if (!branchEmail || unreadInitialRef.current === "hydrated") return;
    unreadInitialRef.current = "hydrated";
    try {
      const saved = JSON.parse(
        localStorage.getItem(unreadStorageKey(branchEmail)) || "{}"
      );
      if (saved && typeof saved === "object" && Object.keys(saved).length) {
        setUnreadCounts((prev) => ({ ...saved, ...prev }));
      }
    } catch {
      /* corrupt snapshot — start clean */
    }
  }, [branchEmail]);

  // Write-through persistence. Skipped until the state object's identity
  // changes from the initial {} so a pre-hydration render can never clobber
  // the stored snapshot with emptiness.
  const unreadIdentityRef = useRef(unreadCounts);
  useEffect(() => {
    if (!branchEmail || unreadCounts === unreadIdentityRef.current) return;
    try {
      localStorage.setItem(
        unreadStorageKey(branchEmail),
        JSON.stringify(unreadCounts)
      );
    } catch {
      /* storage unavailable — in-memory state still correct */
    }
  }, [unreadCounts, branchEmail]);

  useEffect(() => {
    const unsubscribe = onUnreadUpdate(({ guestId, unreadCount }) => {
      setUnreadCounts((prev) => ({
        ...prev,
        [guestId]: unreadCount,
      }));
    });
    return unsubscribe;
  }, []);

  // Write-through the chats snapshot too. Previously `branchChats-<email>`
  // was only written on incoming messages / chat close, so a session that
  // merely LOADED chats left a stale/empty snapshot — and the self-feeding
  // header widgets on other admin pages computed "All caught up" despite
  // waiting guests. Identity-guarded like unreadCounts; persistChatState
  // is already debounced.
  const chatsIdentityRef = useRef(chats);
  useEffect(() => {
    if (!branchEmail || chats === chatsIdentityRef.current) return;
    persistChatState(branchEmail, chats);
  }, [chats, branchEmail]);

  useWakeLock(hydrated);

  // ============================================================================
  // REF SYNC EFFECTS
  // ============================================================================
  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useEffect(() => {
    activeIdsRef.current = activeGuestIds;
  }, [activeGuestIds]);

  // ============================================================================
  // CHAT FETCHING
  // ============================================================================
  const fetchActiveChats = useCallback(async () => {
    // 0) On cold start / socket reconnect, Firebase may not have restored
    //    auth.currentUser yet (browserSessionPersistence hydrates async).
    //    Skip quietly here and let the mount effect re-run once auth is ready,
    //    so we only WARN when the claim is genuinely absent.
    if (!firebaseAuthReady) {
      console.debug(
        "[DASHBOARD] ⏳ Firebase auth not ready yet — deferring chat fetch."
      );
      return;
    }

    // 1) Ensure we have the branchadmin custom-claim
    const hasRoleClaim = await waitForCustomClaims("branchadmin");
    if (!hasRoleClaim) {
      console.warn(
        "[DASHBOARD] ⚠️ Firebase token missing 'branchadmin' claim — skipping fetch."
      );
      return;
    }

    try {
      // 2) Query the most recent messages for this branch
      const q = query(
        collection(db, "messages"),
        where("branchEmail", "==", branchEmail),
        orderBy("timestamp", "desc"),
        limit(CHAT_QUERY_LIMIT)
      );
      const snapshot = await getDocs(q);

      // 3) Build chat entries from messages
      const hydratedChats = buildChatEntriesFromMessages(snapshot);

      // 4) Merge into state without duplicating
      setChats((prev) => mergeChatsIntoState(prev, hydratedChats));
    } catch (err) {
      if (err.code === "auth/quota-exceeded") {
        console.warn(
          "[DASHBOARD] ⚠️ Auth quota exceeded; please wait and retry later."
        );
        return;
      }
      console.error("[DASHBOARD] ❌ Failed to hydrate chats:", err.message);
    }
  }, [branchEmail, firebaseAuthReady, waitForCustomClaims, setChats]);

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================
  const handleIncomingMessage = useCallback(
    async (msg) => {
      console.log("[ADMIN] handleIncomingMessage called with:", msg);
      /* 0. sanity ---------------------------------------------------- */
      if (!msg || !msg.guestId) return;

      // 🔒 HARD GUARD: ignore messages for other branches
      if (
        msg.branchEmail &&
        msg.branchEmail.toLowerCase().trim() !== branchEmail
      ) {
        return;
      }

      const guestId = canon(msg.guestId);
      const selectedId = canon(selectedChatRef.current?.guestId || "");

      // ============================================================================
      // E2EE: Decrypt message content if encrypted
      // ============================================================================
      let decryptedContent = msg.content || "";
      let decryptedMessage = msg.message || msg.content || "";
      
      if (msg.e2ee && msg.content && isE2EEEstablished(guestId)) {
        try {
          const encryptedPayload = JSON.parse(msg.content);
          if (encryptedPayload.ciphertext && encryptedPayload.iv) {
            decryptedContent = await e2eeDecrypt(guestId, encryptedPayload.ciphertext, encryptedPayload.iv);
            decryptedMessage = decryptedContent;
            console.log(`[E2EE] Decrypted message from ${guestId}`);
          }
        } catch (decryptError) {
          console.error(`[E2EE] Decryption failed for ${guestId}:`, decryptError.message);
          decryptedContent = "[Encrypted - Unable to decrypt]";
          decryptedMessage = decryptedContent;
        }
      }

      // Never render raw ciphertext. If the payload is still an encrypted blob
      // (e.g. the secure channel isn't established on this tab yet), show a
      // friendly placeholder instead of the {"ciphertext":...} JSON.
      if (
        msg.e2ee &&
        typeof decryptedContent === "string" &&
        decryptedContent.includes('"ciphertext"')
      ) {
        decryptedContent = "[Encrypted message]";
        decryptedMessage = "[Encrypted message]";
      }
      
      // Prefer our own cached plaintext (admin's outgoing messages) so the
      // thread never reverts to ciphertext/placeholder when the ephemeral key
      // is unavailable on this tab.
      const cachedOwn = getCachedPlaintext(msg.id);
      if (cachedOwn != null) {
        decryptedContent = cachedOwn;
        decryptedMessage = cachedOwn;
      }

      // Update message with decrypted content
      const decryptedMsg = {
        ...msg,
        content: decryptedContent,
        message: decryptedMessage,
        encrypted: msg.e2ee || false,
      };

      /* 1. de-dupe by id -------------------------------------------- */
      if (decryptedMsg.id && lastProcessedMessageIdRef.current === decryptedMsg.id) return;
      lastProcessedMessageIdRef.current = decryptedMsg.id;

      /* 2. ensure / update chat-row (preview & timestamp) ----------- */
      const row = {
        guestId,
        guestName: decryptedMsg.guestName || `Guest ${guestId.slice(-4)}`,
        lastMessage: decryptedContent || "[media]",
        timestamp: decryptedMsg.timestamp || new Date().toISOString(),
        archived: false,
      };

      setChats((prev) => updateChatRow(prev, guestId, row));

      /* 4. unread-badge logic --------------------------------------- */
      handleUnreadCount(guestId, selectedId, msg.sender, setUnreadCounts, setLastReadTimestamps);

      /* 5. keep active-id set in sync ------------------------------- */
      setActiveGuestIds((prev) => {
        if (prev.has(guestId)) return prev;
        const next = new Set(prev);
        next.add(guestId);
        activeIdsRef.current = next;
        return next;
      });

      /* 6. thread handling ------------------------------------------ */
      if (selectedId === guestId) {
        setMessages((prev) => {
          // Check if message already exists and update it with seen status
          const existingIndex = prev.findIndex(m => m.id === msg.id);
          if (existingIndex !== -1) {
            // Update existing message with new seen status + decrypted content
            const updated = [...prev];
            updated[existingIndex] = {
              ...updated[existingIndex],
              content: decryptedMsg.content,
              message: decryptedMsg.message,
              seenByGuest: msg.seenByGuest,
            };
            return updated;
          }
          // Push the DECRYPTED message so the thread shows plaintext, not ciphertext.
          return prev.some((m) => m.id === msg.id) ? prev : [...prev, decryptedMsg];
        });
      } else if (!selectedChatRef.current) {
        // nothing selected → auto-focus the chat that just spoke
        setSelectedChat(row);
        selectedChatRef.current = row;
        setMessages([decryptedMsg]);
        localStorage.setItem("selectedGuestId", guestId);

        // clear unread for this newly opened chat and mark as read
        setUnreadCounts((prev) => ({ ...prev, [guestId]: 0 }));

        // notify server these are now read
        socketInstance.emit("markRead", { guestId });

        setLastReadTimestamps((prev) => {
          const next = { ...prev, [guestId]: Date.now() };
          localStorage.setItem("lastReadTimestamps", JSON.stringify(next));
          return next;
        });
      }

      /* 6. persistence + BC sync ------------------------------------ */
      persistChatState(branchEmail, chatsRef.current);

      try {
        getChatChannel().postMessage({
          type: "newMessage",
          payload: msg,
          branchEmail,
        });
      } catch (e) {
        console.warn("[SYNC] Broadcast failed:", e.message);
      }
    },
    [
      branchEmail,
      canon,
      selectedChatRef,
      lastProcessedMessageIdRef,
      setChats,
      setUnreadCounts,
      setLastReadTimestamps,
      setActiveGuestIds,
      setMessages,
      setSelectedChat,
      getChatChannel,
    ]
  );

  // ── Fetch the open chat’s message thread ───────────────────────────────
  const fetchMessages = useCallback(async () => {
    if (!selectedChat) return;
    setIsLoadingMessages(true);
    try {
      const q = query(
        collection(db, "messages"),
        where("guestId", "==", selectedChat.guestId),
        where("branchEmail", "==", branchEmail),
        orderBy("timestamp", "asc"),
        limit(100)
      );
      const snapshot = await getDocs(q);
      const rawMsgs = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((m) => !m.archived);

      // Decrypt any E2EE messages in the loaded history so the thread shows
      // plaintext instead of raw ciphertext. (Messages from a previous session
      // whose ephemeral key is gone will fall back to a friendly placeholder.)
      const guestId = canon(selectedChat.guestId);
      const msgs = await Promise.all(
        rawMsgs.map(async (m) => {
          const cached = getCachedPlaintext(m.id);
          if (cached != null) {
            return { ...m, content: cached, message: cached, encrypted: true };
          }
          // Treat as encrypted if flagged e2ee OR the content is a {ciphertext,iv}
          // payload (admin's own past replies were stored without the flag).
          const payload = parseEncryptedPayload(m.content);
          if (m.e2ee || payload) {
            if (payload && isE2EEEstablished(guestId)) {
              try {
                const plain = await e2eeDecrypt(guestId, payload.ciphertext, payload.iv);
                return { ...m, content: plain, message: plain, encrypted: true };
              } catch (e) {
                return { ...m, content: "[Encrypted message]", message: "[Encrypted message]", encrypted: true };
              }
            }
            // Encrypted but key not established yet (or unparseable) → placeholder;
            // re-decrypts when the channel establishes (see effect below).
            return { ...m, content: "[Encrypted message]", message: "[Encrypted message]", encrypted: true };
          }
          return m;
        })
      );
      setMessages(msgs);
      return msgs;
    } catch (err) {
      console.error("[DASHBOARD] ❌ Error fetching messages:", err);
    } finally {
      setIsLoadingMessages(false);
    }
  }, [selectedChat, branchEmail]);

  // ============================================================================
  // E2EE: RE-DECRYPT ON CHANNEL ESTABLISHMENT
  // ----------------------------------------------------------------------------
  // Messages can arrive (or the thread can load) BEFORE the key handshake with
  // the guest completes — those render as "[Encrypted message]" and would stay
  // that way forever. When the secure channel becomes established for the open
  // chat, re-fetch the thread so anything that was a placeholder now decrypts.
  // ============================================================================
  useEffect(() => {
    const gid = selectedChat?.guestId;
    if (!gid) return;
    if (e2eeStatus[gid] === "established" || isE2EEEstablished(gid)) {
      fetchMessages();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2eeStatus, selectedChat?.guestId]);

  // activeGuestIds is your Set of open chat IDs
  useEffect(() => {
    if (
      window.electronAPI &&
      typeof window.electronAPI.sendActiveChatsUpdate === "function"
    ) {
      const hasActive = activeGuestIds.size > 0;
      window.electronAPI.sendActiveChatsUpdate(hasActive);
    }
  }, [activeGuestIds]);

  // ── REF FOR LATEST activeGuestIds ───────────────────────────────────
  const activeGuestIdsRef = useRef(activeGuestIds);
  useEffect(() => {
    activeGuestIdsRef.current = activeGuestIds;
  }, [activeGuestIds]);

  useEffect(() => {
    // 1️⃣ Register exactly once
    onNewMessage(handleIncomingMessage);

    // 2️⃣ Clean-up on unmount/HMR.
    return () => {
      socketInstance?.off?.("receiveMessage", handleIncomingMessage);
    };
  }, [handleIncomingMessage]);

  // ── Always refresh chats & thread on every socket reconnect ────────────
  useEffect(() => {
    const onReconnected = async () => {
      console.info(
        "[DASHBOARD] 🔄 adminSocketReconnected: refreshing and recalculating unreads"
      );

      // a) refresh your sidebar list
      await fetchActiveChats();

      // b) auto-open newest if none selected
      if (!selectedChatRef.current && chatsRef.current.length) {
        const latest = chatsRef.current[0];
        setSelectedChat(latest);
        selectedChatRef.current = latest;
        // mark this chat as read AND persist the timestamp
        setLastReadTimestamps((prev) => {
          const next = { ...prev, [latest.guestId]: Date.now() };
          localStorage.setItem("lastReadTimestamps", JSON.stringify(next));
          return next;
        });
      }

      // c) re-fetch the open thread
      await fetchMessages();

      // d) recalc ALL badges by counting unseen messages per chat
      const updates = {};
      await Promise.all(
        chatsRef.current.map(async (chat) => {
          const snap = await getDocs(
            query(
              collection(db, "messages"),
              where("branchEmail", "==", branchEmail),
              where("guestId", "==", chat.guestId),
              where("seenByAdmin", "==", false)
            )
          );
          if (snap.size) {
            updates[chat.guestId] = snap.size;
          }
        })
      );
      if (Object.keys(updates).length) {
        setUnreadCounts((prev) => ({
          ...prev,
          ...updates,
        }));
      }

      // e) re-bind your high-level handler so any replayed messages fire handleIncomingMessage
      onNewMessage(handleIncomingMessage);
    };

    window.addEventListener("adminSocketReconnected", onReconnected);
    return () => {
      window.removeEventListener("adminSocketReconnected", onReconnected);
    };
  }, [
    fetchActiveChats,
    fetchMessages,
    branchEmail,
    setSelectedChat,
    setLastReadTimestamps,
    setUnreadCounts,
    handleIncomingMessage,
  ]);

  const broadcastAdminSync = (type, payload) => {
    try {
      getAdminSyncChannel().postMessage({ type, payload, branchEmail });
      console.log("[ADMIN SYNC] Broadcasted", type);
    } catch (e) {
      console.warn("[ADMIN SYNC] Failed to broadcast:", e.message);
    }
  };

  // Existing getChatChannel is maintained; now we add adminSyncChannel listeners:
  useEffect(() => {
    // Listen for admin-sync messages from other tabs (namespaced)
    const ch = getAdminSyncChannel();
    const handleAdminSync = (event) => {
      const { type, payload, branchEmail: be } = event.data || {};
      // 🔒 ignore other branches
      if (
        (be && be !== branchEmail) &&
        (payload?.branchEmail && payload.branchEmail !== branchEmail)
      ) {
        return;
      }

      console.log("[ADMIN SYNC] Received event", type);

      if (type === "updateChats") {
        /* ----------------------------------------------------------------
           1️⃣  MERGE the incoming chat rows instead of overwriting them
        ----------------------------------------------------------------- */
        if (Array.isArray(payload?.chats)) {
          setChats((prev) => {
            const map = new Map(prev.map((c) => [c.guestId, c])); // keep ours first

            payload.chats.forEach((row) => {
              if (!row?.guestId) return; // 🔕 malformed row (would poison sorts)
              if (row.archived) return; // 🔕 already archived
              if (closedChats[row.guestId]) return; // 🔕 explicitly closed

              const existing = map.get(row.guestId);
              if (!existing) {
                map.set(row.guestId, row); // brand-new chat
              } else if (
                new Date(row.timestamp) > new Date(existing.timestamp)
              ) {
                map.set(row.guestId, { ...existing, ...row }); // newer preview
              }
            });

            const merged = Array.from(map.values());
            chatsRef.current = merged;
            return merged;
          });
        }

        /* ----------------------------------------------------------------
           2️⃣  Presence is SERVER-authoritative (guestPresenceUpdate) and is
           applied per-tab. We deliberately DO NOT merge activeGuestIds across
           tabs here — additive merging resurrects "ghost" guests that another
           tab (or the server) has already cleared. Each tab trusts the live
           presence feed for who is online.
        ----------------------------------------------------------------- */

        isExternalUpdateRef.current = true; // prevent echo-rebroadcast
        return; // ✅ handled
      } else if (type === "chatClosed") {
        // Remove chat from chats state if guestId matches
        setChats((prev) => prev.filter((c) => c.guestId !== payload.guestId));
        setActiveGuestIds((prev) => {
          const newSet = new Set(prev);
          newSet.delete(payload.guestId);
          return newSet;
        });
        // Clear selected chat if needed
        if (selectedChatRef.current?.guestId === payload.guestId) {
          localStorage.removeItem("selectedGuestId");
          setSelectedChat(null);
          setMessages([]);
        }
      } else if (type === "newMessage") {
        handleIncomingMessage(payload);
      }
    };
    ch.addEventListener("message", handleAdminSync);
    return () => ch.removeEventListener("message", handleAdminSync);
  }, [handleIncomingMessage, getAdminSyncChannel, branchEmail, closedChats]);

  // Whenever *our* chats / active IDs change, broadcast the unioned state
  useEffect(() => {
    /* 0️⃣  ignore echoes coming from another tab */
    if (isExternalUpdateRef.current) {
      isExternalUpdateRef.current = false; // reset for next run
      return;
    }

    /* 1️⃣  build a canonical payload – deterministic order */
    const payload = {
      chats: chatsRef.current
        // Drop ghosts AND malformed entries with no guestId — one such entry
        // used to crash every tab via localeCompare(undefined) and kept
        // re-propagating through the cross-tab updateChats broadcast.
        .filter((c) => c?.guestId && !closedChats[c.guestId] && !c.archived)
        .sort((a, b) => (a.guestId || "").localeCompare(b.guestId || "")), // stable sort
      activeGuestIds: [...activeIdsRef.current].sort(), // stable sort
      branchEmail,
    };

    /* 2️⃣  cheap hash (stringify) – if unchanged, skip broadcast      */
    const hash = JSON.stringify(payload);
    if (hash === lastSyncHashRef.current) return; // -- no spam

    lastSyncHashRef.current = hash; // update cache
    broadcastAdminSync("updateChats", payload); // 🔈 once
    console.log("[ADMIN SYNC] Broadcasted updateChats");
  }, [chats, activeGuestIds, closedChats, branchEmail]);

  // When a chat is closed locally (for instance, after receiving socket "chatClosed" event)
  useEffect(() => {
    const handleChatClosedBroadcast = ({ guestId }) => {
      broadcastAdminSync("chatClosed", { guestId, branchEmail });
    };
    socketInstance?.on("chatClosed", handleChatClosedBroadcast);
    return () => {
      socketInstance?.off("chatClosed", handleChatClosedBroadcast);
    };
  }, [socketInstance, branchEmail]);

  // Force a re-sync when the tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.info("[ADMIN SYNC] Tab visible – requesting full state update");
        broadcastAdminSync("updateChats", {
          chats: chatsRef.current,
          activeGuestIds: [...activeIdsRef.current],
          branchEmail,
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [branchEmail]);

  useEffect(() => {
    const waitForFullHydration = async () => {
      const { token, email } = await ensureSessionHydrated();
      if (
        isInitialized &&
        isAuthenticated &&
        fallbackHydrationComplete &&
        sessionHydrated &&
        token &&
        email &&
        branchId &&
        branchEmail
      ) {
        setHydrated(true);
      }
    };
    waitForFullHydration();
  }, [
    isInitialized,
    isAuthenticated,
    fallbackHydrationComplete,
    sessionHydrated,
    branchId,
    branchEmail,
  ]);

  // ─── skip cache hydration entirely; rely on live presence ─────────────────
  useEffect(() => {
    setCacheHydrated(true);
  }, []);

  // D-1: show a brief "syncing…" sidebar skeleton ONLY if authoritative presence
  // takes >200ms to arrive (instant pulls show nothing). A 5s fail-safe flips
  // presenceReady so the skeleton can never hang if a presence frame is missed
  // before Phase B's `requestGuestPresence` handler exists.
  useEffect(() => {
    if (presenceReady) return undefined;
    const showT = setTimeout(() => setShowSyncing(true), 200);
    const failSafeT = setTimeout(() => setPresenceReady(true), 5000);
    return () => {
      clearTimeout(showT);
      clearTimeout(failSafeT);
    };
  }, [presenceReady]);

  /* 🔄  React to JWT rotation in another tab – reconnect once, no extra listeners */
  useEffect(() => {
    const handleTokenChange = (event) => {
      if (event.key !== "branchAdminToken" || !event.newValue) return;

      const newToken = event.newValue;
      if (socketInstance?.auth?.token === newToken) return; // same token → ignore

      console.warn("[SOCKET] 🔄 Token changed in another tab — reconnecting…");

      /* 1️⃣  update auth & disconnect so Admin-Utils-socket will re-attach its
             single onNewMessage → handleIncomingMessage listener for us       */
      if (socketInstance) {
        socketInstance.auth.token = newToken;
        socketInstance.disconnect();
      }

      /* 2️⃣  passive reconnect (Admin-Utils handles listener binding) */
      ensureSessionHydrated()
        .then(({ email }) => email && connectSocket(email, true)) // true = passive
        .catch(console.error);
    };

    window.addEventListener("storage", handleTokenChange);
    return () => window.removeEventListener("storage", handleTokenChange);
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    const connect = async () => {
      const { connectSocket } = await import("../components/Admin-Utils-socket");
      // isPassive=true is REQUIRED here: a fallback-rehydrated tab holds
      // "__FALLBACK_FAKE_TOKEN__", and a non-passive connect aborts on it
      // instead of exchanging it for a real token via /api/issue-fallback-token.
      // That abort left the socket forever disconnected — and the amber
      // "Reconnecting to chat…" banner permanently visible — while chats kept
      // working through Firestore/BroadcastChannel.
      await connectSocket(branchEmail, true); // passive
    };

    connect();
  }, [hydrated, branchEmail]);

  /* keep mirrors fresh for BC replies */
  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);
  useEffect(() => {
    activeIdsRef.current = activeGuestIds;
  }, [activeGuestIds]);

  /* ═════════ 1. Incoming messages & presence ═════════ */
  useEffect(() => {
    const chatChannel = getChatChannel();
    const tabId = localStorage.getItem("tabId");

    // Request the latest chats from any other tabs
    try {
      chatChannel.postMessage({ type: "requestChats", from: tabId, branchEmail });
    } catch (e) {
      console.warn("[SYNC] requestChats failed:", e.message);
    }

    // ➤ Presence is SERVER-authoritative. Apply the set exactly as received —
    //   INCLUDING an empty array (the last guest disconnected) — so closed or
    //   dropped guests can never linger as "ghost" chats. We canonicalize ids
    //   so they match how chat rows are keyed (canon(guestId)), and we apply
    //   even while the tab is hidden (it's just a state update; the server is
    //   the source of truth and the sidebar must reconcile down to reality).
    const handlePresenceUpdate = async (ids) => {
      if (!Array.isArray(ids)) {
        console.warn("[PRESENCE] Ignoring malformed guestPresenceUpdate:", ids);
        return;
      }
      const nextIds = ids.map((id) => canon(id));
      const nextSet = new Set(nextIds);
      setActiveGuestIds(nextSet);
      activeIdsRef.current = nextSet;
      // D-1: authoritative presence has arrived — drop the syncing skeleton.
      setPresenceReady(true);
      // A4: prune chat rows whose guest is no longer in the authoritative set. The
      // render already intersects with activeGuestIds so nothing VISIBLE changes —
      // this just stops stale rows lingering in `chats` (and leaking via cross-tab
      // chats sharing). Guests with recent messages are re-added by the
      // fetchActiveChats() call below or by handleIncomingMessage.
      setChats((prev) => prev.filter((c) => nextSet.has(canon(c.guestId))));
      // D3 (Decision D-3): the authoritative set also governs unread badges. Drop
      // unread counters for guests no longer present, so a thread closed during an
      // admin's offline gap can't leave an orphan badge (or a stale count that could
      // resurface if that guestId is ever reused). Absence from the authoritative
      // pull already means "gone" — that is exactly the cleanup signal, so no
      // separate recently-closed set is needed for badge/selection hygiene.
      setUnreadCounts((prev) => {
        let changed = false;
        const next = {};
        for (const gid of Object.keys(prev)) {
          if (nextSet.has(canon(gid))) next[gid] = prev[gid];
          else changed = true;
        }
        return changed ? next : prev;
      });
      // Presence is authoritative for the sidebar — it must be authoritative for
      // the OPEN thread too. If the guest we're viewing is no longer in the live
      // set (they closed/dropped, or the set is now empty), clear the selection +
      // messages so the right pane can't linger as a "ghost" chat after the
      // sidebar has already reconciled down to reality. Mirrors chatClosed.
      const openGuestId = selectedChatRef.current?.guestId;
      if (openGuestId && !nextSet.has(openGuestId)) {
        localStorage.removeItem("selectedGuestId");
        setSelectedChat(null);
        selectedChatRef.current = null;
        setMessages([]);
      }
      // Refresh previews so brand-new guest threads appear (nothing to hydrate
      // when the set is empty).
      if (nextIds.length > 0) {
        try {
          await fetchActiveChats();
        } catch (err) {
          console.warn("[PRESENCE] fetchActiveChats failed:", err.message);
        }
      }
    };

    socketInstance.on("guestPresenceUpdate", handlePresenceUpdate);

    // ── Rebinding logic (throttled) remains the same… ───────────────────
    let lastRebindAt = 0;
    const rebindSocketListeners = () => {
      const now = Date.now();
      if (now - lastRebindAt < 2000) return;
      lastRebindAt = now;

      if (!socketInstance?.on) {
        console.warn("[DASHBOARD] ⚠️ Socket not ready — skipping rebind");
        return;
      }

      socketInstance.off("guestPresenceUpdate", handlePresenceUpdate);
      socketInstance.on("guestPresenceUpdate", handlePresenceUpdate);

      socketInstance.__messageListenerAttached = true;
      console.debug("[DASHBOARD] 🔁 Rebound socket listeners");

      // A3: pull authoritative presence right AFTER (re)binding the listener so the
      // response can't lose the rebind race (B1). Runs on initial connect (when
      // already connected at mount) and on every reconnect via onSocketConnected.
      // The reply is a normal guestPresenceUpdate handled above. Harmless no-op
      // until Phase B adds the server-side `requestGuestPresence` handler; the
      // server's connection-time push + 5s fail-safe keep the UI correct meanwhile.
      if (socketInstance?.connected) {
        socketInstance.emit("requestGuestPresence");
      }
    };

    BranchChatDashboard._rebindSocketListeners = rebindSocketListeners;
    window.__ADMIN_SOCKET_REBINDER__ = rebindSocketListeners;

    if (socketInstance?.connected) {
      rebindSocketListeners();
    }
    onSocketConnected(rebindSocketListeners);

    // Cleanup
    return () => {
      socketInstance?.off("guestPresenceUpdate", handlePresenceUpdate);
    };
  }, [socketInstance, fetchActiveChats, getChatChannel, branchEmail]);

  /* ═════════ 2. Remove chat when chatClosed arrives ═════════ */

  /* ════════════════════════════════════════════════════════════════ */
  /*  Sync on chatClosed (admin dashboard)                           */
  /* ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const handleChatClosed = ({ guestId }) => {
      const gId = canon(guestId);

      /* 1️⃣  mark archived + prune lists/sets */
      setChats((prev) =>
        prev
          .map((c) => (c.guestId === gId ? { ...c, archived: true } : c))
          .filter((c) => c.guestId !== gId) // remove from UI
      );

      setActiveGuestIds((prev) => {
        const next = new Set(prev);
        next.delete(gId);
        return next;
      });

      setClosedChats((prev) => ({ ...prev, [gId]: Date.now() }));

      /* 2️⃣  clear selection if this chat was open */
      if (selectedChatRef.current?.guestId === gId) {
        localStorage.removeItem("selectedGuestId");
        setSelectedChat(null);
        setMessages([]);
      }

      /* 3️⃣  persist & broadcast  – nuke stored selection unconditionally */
      localStorage.removeItem("selectedGuestId");
      const newChats = chatsRef.current.filter((c) => c.guestId !== gId);
      const newIds = new Set(activeIdsRef.current);
      newIds.delete(gId);

      localStorage.setItem(
        `branchChats-${branchEmail}`,
        JSON.stringify({
          version: LOCAL_STORAGE_VERSION,
          chats: newChats,
          activeGuestIds: [], // A1: presence is live/server-only — never persisted
        })
      );

      try {
        const chatChannel = getChatChannel();
        chatChannel.postMessage({
          type: "chatClosed",
          payload: { guestId: gId, branchEmail },
          branchEmail,
        });
        chatChannel.postMessage({
          type: "updateChats",
          payload: { chats: newChats, activeGuestIds: [...newIds], branchEmail },
          branchEmail,
        });
      } catch (e) {
        console.warn("[SYNC] Broadcast failed:", e.message);
      }
    };

    const logAny = (ev, ...a) => console.log("[DASHBOARD] 🧪", ev, a);

    socketInstance?.on?.("chatClosed", handleChatClosed);
    socketInstance?.onAny?.(logAny);

    return () => {
      socketInstance?.off?.("chatClosed", handleChatClosed);
      socketInstance?.offAny?.(logAny);
    };
  }, [socketInstance?.id, branchEmail, getChatChannel]);

  /* wipe selected thread if its guest is no longer active */
  useEffect(() => {
    // Only clear selection on true “closed” events—ignore on hidden‐window presence drops
    if (
      selectedChat &&
      document.visibilityState === "visible" &&
      !activeGuestIds.has(selectedChat.guestId)
    ) {
      setSelectedChat(null);
      selectedChatRef.current = null;
      setMessages([]);
      localStorage.removeItem("selectedGuestId");
    }
  }, [activeGuestIds, selectedChat]);

  /* ═════════ 3. onmessage / request-reply ═════════ */

  useEffect(() => {
    const chatChannel = getChatChannel();
    const tabId = localStorage.getItem("tabId");

    chatChannel.onmessage = ({ data }) => {
      const { type, payload, from, branchEmail: be } = data || {};
      const guestId = payload?.guestId;

      // 🔒 ignore cross-branch chatter
      if (
        (be && be !== branchEmail) &&
        (payload?.branchEmail && payload.branchEmail !== branchEmail)
      ) {
        return;
      }

      if (type === "requestChats") {
        try {
          chatChannel.postMessage({
            type: "updateChats",
            payload: {
              chats: chatsRef.current,
              activeGuestIds: [...activeIdsRef.current],
              branchEmail,
            },
            branchEmail,
          });
        } catch (e) {
          console.warn("[SYNC] reply failed:", e.message);
        }
        return;
      }

      if (type === "updateChats") {
        if (payload?.chats) {
          const prev = JSON.stringify(chatsRef.current);
          const incoming = JSON.stringify(payload.chats);

          if (prev !== incoming) {
            setChats(payload.chats);
            chatsRef.current = payload.chats;
          }
        }

        // A2: presence is live/server-authoritative PER TAB. We deliberately do NOT
        // apply another tab's activeGuestIds here — additive cross-tab merging
        // resurrects "ghost" guests the server already cleared (R2/B3). Each tab
        // trusts its own guestPresenceUpdate feed (mirrors the adminSync handler).

        // 🔁 Rehydrate thread if selected chat was updated
        if (selectedChatRef.current) {
          const updated = payload.chats?.find(
            (c) => c.guestId === selectedChatRef.current.guestId
          );
          if (updated) {
            const now = Date.now();
            if (now - lastMessageHydration.current < 3000 || isLoadingMessages)
              return;
            lastMessageHydration.current = now;

            const fetchUpdatedMessages = async () => {
              try {
                const q = query(
                  collection(db, "messages"),
                  where("guestId", "==", selectedChatRef.current.guestId),
                  where("branchEmail", "==", branchEmail),
                  orderBy("timestamp", "asc"),
                  limit(100)
                );
                const snapshot = await getDocs(q);
                const rawMsgs = snapshot.docs
                  .map((doc) => ({ id: doc.id, ...doc.data() }))
                  .filter((msg) => msg.archived !== true);

                // Decrypt E2EE messages so this sync path never overwrites the
                // thread with raw ciphertext (e.g. after switching tabs back to
                // the admin). Mirrors the decryption logic in fetchMessages.
                const gid = canon(selectedChatRef.current.guestId);
                const msgs = await Promise.all(
                  rawMsgs.map(async (m) => {
                    const cached = getCachedPlaintext(m.id);
                    if (cached != null) {
                      return { ...m, content: cached, message: cached, encrypted: true };
                    }
                    // Treat as encrypted by flag OR {ciphertext,iv} shape (admin's
                    // own past replies were stored without the e2ee flag).
                    const payload = parseEncryptedPayload(m.content);
                    if (m.e2ee || payload) {
                      if (payload && isE2EEEstablished(gid)) {
                        try {
                          const plain = await e2eeDecrypt(gid, payload.ciphertext, payload.iv);
                          return { ...m, content: plain, message: plain, encrypted: true };
                        } catch (e) {
                          return { ...m, content: "[Encrypted message]", message: "[Encrypted message]", encrypted: true };
                        }
                      }
                      return { ...m, content: "[Encrypted message]", message: "[Encrypted message]", encrypted: true };
                    }
                    return m;
                  })
                );
                setMessages(msgs);
              } catch (err) {
                console.warn(
                  "[SYNC] Failed to fetch messages from BC sync:",
                  err.message
                );
              }
            };
            fetchUpdatedMessages();
          }
        }
        return;
      }

      if (type === "newMessage" && payload && guestId) {
        if (payload.id === lastProcessedMessageIdRef.current) {
          return; // ⚠️ Skip duplicate processing
        }

        if (typeof BranchChatDashboard?._rebindSocketListeners === "function") {
          clearTimeout(window.__REBIND_DEBOUNCE__);
          window.__REBIND_DEBOUNCE__ = setTimeout(() => {
            BranchChatDashboard._rebindSocketListeners();
          }, 200); // ⏱️ 200ms debounce
        }

        handleIncomingMessage(payload);
        return;
      }

      if (type === "requestChats" && from !== tabId) {
        try {
          chatChannel.postMessage({
            type: "updateChats",
            payload: {
              chats: chatsRef.current,
              activeGuestIds: [...activeIdsRef.current],
              branchEmail,
            },
            branchEmail,
          });
        } catch (e) {
          console.warn("[SYNC] reply failed:", e.message);
        }
      }
    };
  }, [branchEmail, isLoadingMessages, getChatChannel, handleIncomingMessage]);

  const updateLastPendingMessageAsFailed = (failureReason) => {
    setMessages((prev) => {
      const updated = [...prev];
      // Use lastIndexOf to target the most recent pending message.
      const pendingFlags = updated.map((m) => !!m.pending);
      const idx = pendingFlags.lastIndexOf(true);
      if (idx !== -1) {
        updated[idx] = {
          ...updated[idx],
          status: "failed", // mark as failed
          pending: true, // still marked pending (not delivered)
          failureReason, // store failure reason (optional)
          // For admin messages, always use the dedicated retry function.
          retry: () => retryAdminMessage(updated[idx]),
        };
      }
      return updated;
    });
    setError(""); // Clear any global error messages
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() && !media) {
      setError("Cannot send an empty message.");
      return;
    }

    if (!selectedChat?.guestId || !branchId || !branchEmail) {
      console.error("[ADMIN] ❌ Missing identifiers. Cannot send message.");
      updateLastPendingMessageAsFailed("Missing identifiers");
      return;
    }

    // Always use the latest token
    const token =
      sessionStorage.getItem("branchAdminToken") ||
      localStorage.getItem("branchAdminToken");

    if (isTokenExpired(token)) {
      console.warn(
        "[ADMIN] ❌ Cannot send — token expired. Attempting refresh via reconnect..."
      );
      updateLastPendingMessageAsFailed("Session token expired. Refreshing...");
      return;
    }

    const guestId = selectedChat.guestId;

    try {
      setIsLoadingMessages(true);
      
      // ============================================================================
      // E2EE: Encrypt message content if secure channel is established
      // ============================================================================
      let encryptedPayload = null;
      let encryptionMetadata = null;
      let contentToSend = newMessage;
      
      if (isE2EEEstablished(guestId) && newMessage.trim()) {
        try {
          encryptedPayload = await e2eeEncrypt(guestId, newMessage);
          encryptionMetadata = {
            e2ee: true,
            algorithm: "AES-256-GCM",
            keyExchange: "ECDH-P-256",
          };
          contentToSend = JSON.stringify(encryptedPayload);
          console.log(`[E2EE] Message encrypted for ${guestId}`);
        } catch (e2eeError) {
          console.error(`[E2EE] Encryption failed for ${guestId}:`, e2eeError.message);
          // Continue with plaintext if encryption fails
          contentToSend = newMessage;
        }
      }
      
      console.log("[ADMIN] 📨 Sending message payload:", {
        branchId,
        branchEmail,
        guestId,
        content: contentToSend,
        encrypted: !!encryptedPayload,
      });

      // 1. Create an optimistic message (show plaintext locally; blob preview
      // for an attached image — AdminMessageItem renders blob:/data: directly)
      const optimisticMedia = media
        ? { type: "image", url: URL.createObjectURL(media) }
        : null;
      const optimisticMessage = createOptimisticMessage(
        guestId,
        branchEmail,
        newMessage,
        optimisticMedia
      );
      setMessages((prev) => [...prev, optimisticMessage]);

      // 2. Build fetch options with encrypted content
      const url = `${process.env.REACT_APP_API_URL}/api/messages/reply`;
      const options = buildMessageFetchOptions(token, guestId, contentToSend, media, !!encryptedPayload, encryptionMetadata);

      // 3. Send with backoff on 429
      const response = await fetchWithBackoff(url, options);
      const data = await response.json();

      if (response.ok && data.savedReply) {
        // 4. Confirmed message
        const savedMessage = createConfirmedMessage(data.savedReply, guestId, branchEmail, optimisticMessage.tempId);
        // Keep our own thread showing plaintext when E2EE is on — the server
        // echoes back the ciphertext in `content`, which must never be rendered raw.
        if (encryptedPayload) {
          savedMessage.content = newMessage;
          savedMessage.message = newMessage;
          savedMessage.encrypted = true;
          // Cache our own plaintext by server id so any later re-fetch (tab
          // switch / reconnect / key not established) still renders plaintext.
          cacheOutgoingPlaintext(savedMessage.id, newMessage);
        }
        setMessages((prev) =>
          prev.map((msg) => (msg.tempId === optimisticMessage.tempId ? savedMessage : msg))
        );
        // The confirmed message carries the storage path (resolved to a signed
        // URL by AdminMessageItem) — the local blob preview can be released.
        if (optimisticMedia?.url) URL.revokeObjectURL(optimisticMedia.url);
        console.log(
          "[ADMIN] ✅ Message confirmed by server and UI updated:",
          savedMessage
        );

        // 5. WebSocket emit. When an E2EE channel is established, emit the
        // ciphertext (JSON {ciphertext, iv}) in `content` so the guest can
        // decrypt it — never broadcast plaintext over the wire. The guest's
        // handler JSON-parses `content` and decrypts when `e2ee` is true.
        sendMessage({
          room: `guest-${guestId}`,
          guestId,
          content: encryptedPayload ? JSON.stringify(encryptedPayload) : newMessage,
          sender: "branch",
          id: savedMessage.id,
          timestamp: savedMessage.timestamp,
          e2ee: !!encryptedPayload,
          encryptedContent: encryptedPayload,
          // Attachment path from the confirmed reply — the guest resolves it
          // to a signed URL exactly like guest-sent media.
          media: savedMessage.media || null,
        })
          .then((ackResult) => {
            console.log(
              "[SOCKET] 📡 WebSocket ack received for admin message:",
              ackResult
            );
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === savedMessage.id
                  ? { ...msg, status: "delivered", pending: false }
                  : msg
              )
            );
          })
          .catch((err) => {
            console.error("[SOCKET] ❌ WebSocket error for admin message:", err);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === savedMessage.id
                  ? {
                      ...msg,
                      status: "failed",
                      pending: true,
                      retry: () => retryAdminMessage(savedMessage),
                    }
                  : msg
              )
            );
          });

        // 6. BroadcastChannel (namespaced + branchEmail)
        try {
          const chatChannel = getChatChannel();
          chatChannel.postMessage({
            type: "newMessage",
            payload: savedMessage,
            branchEmail,
          });
        } catch (e) {
          console.warn("[SYNC] BroadcastChannel emit failed:", e.message);
        }
      } else {
        console.error("[ADMIN] ❌ Message send failed:", data);
        updateLastPendingMessageAsFailed(data.error || "REST API failed");
      }

      // 7. Cleanup input
      setNewMessage("");
      setMedia(null);
      if (inputFileRef.current) inputFileRef.current.value = "";
    } catch (err) {
      console.error("[ADMIN] ❌ Unexpected error:", err.message);
      updateLastPendingMessageAsFailed(err.message || "Unexpected error");
    } finally {
      setIsLoadingMessages(false);
    }
  };

  // ✅ Guard: ensure session is ready before rendering
  // ✅ SESSION CONFIRMATION
  useEffect(() => {
    if (!isInitialized || !fallbackHydrationComplete || !sessionHydrated) return;

    if (!branchId || !branchEmail || !branchName) {
      console.error("[SESSION] ❌ Missing session values from context.");
      navigate("/branch-admin-login", { replace: true });
    } else {
      console.info("[SESSION] ✅ Session confirmed:", {
        branchId,
        branchEmail,
        branchName,
        sessionTabId: window.name,
      });
    }
  }, [isInitialized, fallbackHydrationComplete, sessionHydrated]);

  // ✅ Claim socket ownership on first tab
  useEffect(() => {
    const tabId = localStorage.getItem("tabId");
    const activeSocketTabId = localStorage.getItem("activeSocketTabId");

    if (
      fallbackHydrationComplete &&
      isInitialized &&
      !activeSocketTabId &&
      tabId &&
      branchEmail
    ) {
      console.info("[DASHBOARD] 🏁 Claiming initial socket ownership");
      localStorage.setItem("activeSocketTabId", tabId);
    }
  }, [isInitialized, fallbackHydrationComplete, branchEmail]);

  // ✅ BroadcastChannel + passive reconnect loop
  useEffect(() => {
    if (!branchId || !branchEmail || !isInitialized || !isAuthenticated) return;

    const tabId = localStorage.getItem("tabId");
    const sessionTabId = window.name;
    const bc = new BroadcastChannel("admin-socket");
    const openTabs = new Set([tabId]);

    console.log("[DASHBOARD] 🔄 Tab init broadcast", { tabId });
    bc.postMessage({ type: "tab-init", tabId });

    // 🔄 Track other tabs + reclaim ownership
    bc.onmessage = ({ data }) => {
      const { type, tabId: otherTabId } = data;
      if (!otherTabId || otherTabId === tabId) return;

      if (type === "tab-init") {
        openTabs.add(otherTabId);
        console.log(
          "[DASHBOARD] 🔁 Received tab-init — responding with tab-alive",
          {
            from: otherTabId,
            to: tabId,
          }
        );
        bc.postMessage({ type: "tab-alive", tabId });
      }

      if (type === "tab-active") {
        const activeSocketTabId = localStorage.getItem("activeSocketTabId");
        if (tabId === activeSocketTabId && document.visibilityState !== "visible") {
          console.warn("[DASHBOARD] ⚠️ Lost ownership — clearing activeSocketTabId");
          localStorage.removeItem("activeSocketTabId");
        }
      }

      if (type === "tab-closing") {
        openTabs.delete(otherTabId);
        const activeSocketTabId = localStorage.getItem("activeSocketTabId");
        if (otherTabId === activeSocketTabId && tabId !== otherTabId) {
          localStorage.setItem("activeSocketTabId", tabId);
          console.info("[DASHBOARD] 🔁 Reclaiming socket ownership", {
            newOwner: tabId,
          });
        }
      }
    };

    // ✅ Regular presence broadcast every 5s
    const broadcastInterval = setInterval(async () => {
      const session = await ensureSessionHydrated();
      const token = session?.token;
      const email = session?.email;

      const isReady =
        isInitialized &&
        fallbackHydrationComplete &&
        sessionHydrated &&
        token &&
        email &&
        sessionTabId;

      if (!isReady) {
        console.warn("[BROADCAST] ⚠️ Session not fully ready — skipping emit", {
          isInitialized,
          fallbackHydrationComplete,
          sessionHydrated,
          tokenPresent: !!token,
          emailPresent: !!email,
          sessionTabIdPresent: !!sessionTabId,
        });
        return;
      }

      const timestamp = Date.now();
      const payload = { tabId, sessionTabId, branchEmail: email, timestamp };

      try {
        if (window.socketInstance?.connected) {
          // SPD5-4 (speed megaplan): while connected, the 2s socket-utils
          // heartbeat already emits these exact three events on this same
          // socket (window.socketInstance IS the utils instance). Skip the
          // duplicate 5s emits when that heartbeat is verifiably running —
          // presence cadence stays 2s, total emit volume drops. This branch
          // still emits as a safety net if the heartbeat is ever stopped
          // while the socket remains connected.
          if (!isHeartbeatActive()) {
            window.socketInstance.emit("heartbeat");
            window.socketInstance.emit("tabAlive", {
              tabId,
              sessionTabId,
              timestamp,
            });
            window.socketInstance.emit("broadcastAlive", payload);

            console.log("[BROADCAST] 📡 Emitted from tab", {
              ...payload,
              socketConnected: true,
            });
          }
        } else if (document.visibilityState === "visible") {
          console.warn(
            "[BROADCAST] ⚠️ No socket — triggering passive connect",
            {
              tabId,
              sessionTabId,
            }
          );

          const { connectSocket } = await import(
            "../components/Admin-Utils-socket"
          );
          const hydrated = await ensureSessionHydrated();

          if (hydrated.token && hydrated.email) {
            await connectSocket(hydrated.email, true);
          } else {
            console.warn(
              "[BROADCAST] 🚫 Aborting passive connect — session not ready",
              {
                tokenPresent: !!hydrated.token,
                emailPresent: !!hydrated.email,
                tabId,
                sessionTabId,
              }
            );
          }
        }

        bc.postMessage({ type: "tab-alive", tabId });
      } catch (err) {
        console.error("[BROADCAST] 💥 Emit error:", err.message);
      }
    }, 5000);

    // ── Only signal on real unload or when becoming visible ─────────────
    const handleVisibilityChange = async () => {
      if (document.visibilityState === "hidden") {
        // Do nothing on simple hide
        console.log("[DASHBOARD] Tab hidden — no disconnect signal sent");
      } else if (document.visibilityState === "visible") {
        // Broadcast that this tab is active again
        bc.postMessage({ type: "tab-active", tabId });

        // If socket dropped while hidden, reconnect
        if (window.socketInstance && !window.socketInstance.connected) {
          console.warn(
            "[DASHBOARD] ⚠️ No socket on visibility regain — reconnecting"
          );
          const { connectSocket } = await import(
            "../components/Admin-Utils-socket"
          );
          await connectSocket(branchEmail, true);
        }
      }
    };

    const handleTabClose = () => {
      console.log("[DASHBOARD] ❌ Tab unloading — signaling tab-closing");
      bc.postMessage({ type: "tab-closing", tabId });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleTabClose);
    window.addEventListener("pagehide", handleTabClose);

    return () => {
      clearInterval(broadcastInterval);
      bc.close();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleTabClose);
      window.removeEventListener("pagehide", handleTabClose);
    };
  }, [
    branchEmail,
    branchId,
    isAuthenticated,
    isInitialized,
    fallbackHydrationComplete,
    sessionHydrated,
  ]);

  // ✅ AUTO REDIRECT ON LOGOUT
  useEffect(() => {
    if (!isAuthenticated) {
      navigate("/branch-admin-login", { replace: true });
    }
  }, [isAuthenticated]);

  // ✅ WAKE TRIGGERED HEARTBEAT
  useEffect(() => {
    const handleWake = async () => {
      const sessionTabId = window.name;
      const token = sessionStorage.getItem("branchAdminToken");
      const email = sessionStorage.getItem("branchEmail");

      if (document.visibilityState === "visible" && token && email && sessionTabId) {
        console.info(
          "[DASHBOARD] 💤 Wake event — reconnecting socket + triggering heartbeat"
        );

        const { connectSocket } = await import(
          "../components/Admin-Utils-socket"
        );
        await connectSocket(email, true); // passive = true

        startHeartbeat(sessionTabId); // 👈 startHeartbeat is already defined
      }
    };

    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("focus", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("focus", handleWake);
    };
  }, []);

  // ✅ Update chat selection ref
  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  // ✅ Hydrate chats on mount once all session flags are true.
  //    Includes firebaseAuthReady so the first fetch waits for Firebase to
  //    restore auth.currentUser, then re-runs automatically once it flips true.
  useEffect(() => {
    if (
      !branchId ||
      !branchEmail ||
      !isInitialized ||
      !fallbackHydrationComplete ||
      !sessionHydrated ||
      !isAuthenticated ||
      !firebaseAuthReady
    ) {
      return;
    }

    fetchActiveChats();
  }, [
    branchId,
    branchEmail,
    isInitialized,
    fallbackHydrationComplete,
    sessionHydrated,
    isAuthenticated,
    firebaseAuthReady,
    fetchActiveChats,
  ]);

  useEffect(() => {
    if (selectedChat && chats.length > 0) {
      const stillExists = chats.some((c) => c.guestId === selectedChat.guestId);
      if (!stillExists) {
        setSelectedChat(null);
        setMessages([]);
        localStorage.removeItem("selectedGuestId");
      }
    }
  }, [chats, selectedChat]);

  // ✅ Fetch full message history when selected chat changes
  useEffect(() => {
    if (!selectedChat) return;
    setMessages([]);
    fetchMessages();
  }, [selectedChat, fetchMessages]);

  // Branch-Chat-Dashboard.js (somewhere below your other useEffects)
  useEffect(() => {
    const ch = getAdminSyncChannel();
    const handleSync = (event) => {
      const { type, payload, branchEmail: be } = event.data || {};
      // 🔒 ignore cross-branch
      if (
        (be && be !== branchEmail) &&
        (payload?.branchEmail && payload.branchEmail !== branchEmail)
      ) {
        return;
      }
      if (type === "newMessage") {
        handleIncomingMessage(payload);
      }
    };
    ch.addEventListener("message", handleSync);
    return () => ch.removeEventListener("message", handleSync);
  }, [handleIncomingMessage, getAdminSyncChannel, branchEmail]);

  //🔹 Secure Logout Button Component — ghost style on the navy header
  const AdminLogoutButton = () => (
    <button
      onClick={handleLogout}
      className="logout-ghost-btn"
      title="Sign out securely"
    >
      Logout
    </button>
  );

  const handleChatSelect = useCallback(
    (chat) => {
      // 1️⃣ canonical id
      const id = canon(chat.guestId);

      // keep-alive: if we’re already on this thread, do nothing
      if (canon(selectedChatRef.current?.guestId || "") === id) return;

      // 2️⃣ normalize + store selected chat everywhere
      const normalizedChat = { ...chat, guestId: id };
      setSelectedChat(normalizedChat);
      selectedChatRef.current = normalizedChat;
      localStorage.setItem("selectedGuestId", id);

      // 3️⃣ hard-clear the pane before fetching history
      setMessages([]);
      setTypingIndicator(null);

      // 4️⃣ clear unread badge for this conversation
      setUnreadCounts((prev) => ({
        ...prev,
        [id]: 0,
      }));

      // 5️⃣ notify server that this chat is now read
      socketInstance.emit("markRead", { guestId: id });

      // 6️⃣ persist the “last read” timestamp
      setLastReadTimestamps((prev) => {
        const next = { ...prev, [id]: Date.now() };
        localStorage.setItem("lastReadTimestamps", JSON.stringify(next));
        return next;
      });

      // 7️⃣ fetch and display the full message history
      fetchMessages();
    },
    [
      canon,
      selectedChatRef,
      setSelectedChat,
      setMessages,
      setTypingIndicator,
      setUnreadCounts,
      setLastReadTimestamps,
      fetchMessages,
      socketInstance,
    ]
  );

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-500">
        <p className="text-lg">Loading chat dashboard...</p>
      </div>
    );
  }

  const retryAdminMessage = async (failedMessage) => {
    // Retrieve the current token.
    const token = sessionStorage.getItem("branchAdminToken");
    if (!token) {
      console.error("[ADMIN RETRY] ❌ No token available for retry");
      return;
    }

    try {
      setIsLoadingMessages(true);

      // Build request URL and options for backoff-fetch
      const url = `${process.env.REACT_APP_API_URL}/api/messages/reply`;
      let options = {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
        body: null,
      };

      if (failedMessage.media) {
        const formData = new FormData();
        formData.append("guestId", failedMessage.guestId);
        formData.append("content", failedMessage.content);
        formData.append("media", failedMessage.media);
        options.body = formData;
      } else {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify({
          guestId: failedMessage.guestId,
          content: failedMessage.content,
        });
      }

      // Use backoff-fetch instead of plain fetch
      const response = await fetchWithBackoff(url, options);
      const data = await response.json();

      if (response.ok && data.savedReply) {
        // Preserve the tempId so we can match & replace our optimistic message.
        const confirmedMessage = {
          ...data.savedReply,
          guestId: failedMessage.guestId,
          branchEmail: failedMessage.branchEmail,
          sender: "branch",
          status: "sent",
          pending: false,
          archived: false,
          message: data.savedReply.content || failedMessage.content,
          content: data.savedReply.content || failedMessage.content,
          tempId: failedMessage.tempId,
        };

        // Replace the failed optimistic message
        setMessages((prev) =>
          prev.map((msg) =>
            msg.tempId === failedMessage.tempId ? confirmedMessage : msg
          )
        );
        console.log(
          "[ADMIN RETRY] ✅ Retried message confirmed:",
          confirmedMessage
        );

        // Emit via WebSocket
        sendMessage({
          room: `guest-${failedMessage.guestId}`,
          guestId: failedMessage.guestId,
          content: confirmedMessage.content,
          sender: "branch",
          id: confirmedMessage.id,
          timestamp: confirmedMessage.timestamp,
        })
          .then((ack) => {
            console.log("[ADMIN RETRY] 📡 WebSocket ack received:", ack);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === confirmedMessage.id
                  ? { ...msg, status: "delivered", pending: false }
                  : msg
              )
            );
          })
          .catch((err) => {
            console.error("[ADMIN RETRY] ❌ WebSocket ack error on retry:", err);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === confirmedMessage.id
                  ? {
                      ...msg,
                      status: "failed",
                      pending: true,
                      retry: () => retryAdminMessage(confirmedMessage),
                    }
                  : msg
              )
            );
          });
      } else {
        console.error("[ADMIN RETRY] ❌ Retry REST API failed:", data?.error);
      }
    } catch (err) {
      console.error("[ADMIN RETRY] ❌ Error during admin retry:", err.message);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  // Ghost-chat guard: the right pane must only render a thread that still
  // exists in the presence-authoritative sidebar list. Without this, a stale
  // `selectedChat` would keep rendering its conversation even after the guest
  // dropped from `activeGuestIds` and the sidebar emptied — the "ghost chat".
  const selectedChatIsActive =
    !!selectedChat &&
    sortedActiveChats.some((c) => c.guestId === selectedChat.guestId);

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="w-full bg-gray-800 text-white p-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          {/* Company logo (public/images) as a rounded brand tile */}
          <img
            src={`${process.env.PUBLIC_URL}/images/magis%20cover%20photo.png`}
            alt="Magi's Gold & Gems — Pawnshop & Jewellery"
            className="brand-logo"
          />
          <span className="h-8 w-px bg-white/15" aria-hidden="true" />
          <h1 className="text-xl font-semibold">Branch Chat Dashboard</h1>
          <AdminNavigation currentPage="/admin/chats" />
        </div>
        <div className="flex items-center gap-3">
          <AdminHeaderWidgets
            chats={sortedActiveChats}
            unreadCounts={unreadCounts}
          />
          {isAuthenticated && <AdminLogoutButton />}
        </div>
      </div>

      {/* Network/connection status banner (offline / reconnecting / back-online) */}
      <ConnectionStatus />

      <div className="flex flex-row flex-grow overflow-hidden">
        {/* Sidebar */}
        <div className="w-1/3 bg-gray-100 border-r flex flex-col">
          {/* Active Chats list */}
          {(
            <div className="overflow-y-auto flex-grow">
              {sortedActiveChats.length === 0 ? (
                !presenceReady && showSyncing ? (
                  <div
                    className="px-4 py-4 space-y-3"
                    aria-busy="true"
                    aria-label="Syncing active chats"
                  >
                    <p className="text-xs text-gray-400 italic">Syncing…</p>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="animate-pulse flex flex-col gap-2">
                        <div className="h-3 w-24 bg-gray-300 rounded" />
                        <div className="h-3 w-40 bg-gray-200 rounded" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 px-4 py-4 italic">
                    No active guest chats at the moment.
                  </p>
                )
              ) : (
                sortedActiveChats.map((chat, index) => {
                  const isSelected = selectedChat?.guestId === chat.guestId;
                  const unread = unreadCounts[chat.guestId] || 0;
                  return (
                    <div
                      key={chat.guestId || index}
                      onClick={() => handleChatSelect(chat)}
                      className={`p-4 border-b cursor-pointer transition duration-150 ease-in-out ${
                        isSelected ? "bg-blue-100" : "hover:bg-gray-200"
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex flex-col">
                          <div className="flex items-center">
                            <p className="font-medium text-gray-900 truncate max-w-[140px]">
                              {chat.guestName || `Guest ${index + 1}`}
                            </p>
                            {unread > 0 && (
                              <span className="ml-2 inline-flex items-center justify-center px-2 py-1 text-xs font-semibold text-white bg-red-500 rounded-full">
                                {unread}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-600 truncate max-w-[180px]">
                            {chat.lastMessage || "No messages yet"}
                          </p>
                        </div>
                        <div className="text-xs text-gray-500 text-right ml-2 shrink-0 whitespace-nowrap">
                          <p>
                            {new Date(chat.timestamp).toLocaleDateString("en-US", {
                              month: "short",
                              day: "2-digit",
                            })}
                          </p>
                          <p>
                            {new Date(chat.timestamp).toLocaleTimeString("en-US", {
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

        </div>

        {/* Main Chat View */}
        <div className="w-2/3 flex flex-col">
          {activeTab === "chats" && selectedChatIsActive ? (
            <>
              {/* E2EE Security Status */}
              {e2eeStatus[selectedChat.guestId] === "established" ? (
                <div className="bg-green-50 text-green-700 text-[10px] px-3 py-1 border-b border-green-200 flex items-center justify-center gap-1">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z"/>
                  </svg>
                  <span>Encrypted (AES-256-GCM)</span>
                </div>
              ) : e2eeStatus[selectedChat.guestId] === "failed" ? (
                <div className="bg-orange-50 text-orange-700 text-[10px] px-3 py-1 border-b border-orange-200 flex items-center justify-center gap-1">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                  </svg>
                  <span>Secure connection failed - standard encryption only</span>
                </div>
              ) : (
                <div className="bg-blue-50 text-blue-700 text-[10px] px-3 py-1 border-b border-blue-200 flex items-center justify-center gap-1">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                  <span>Establishing secure channel...</span>
                </div>
              )}

              {/* DLP Warning */}
              <div className="bg-gray-100 text-gray-600 text-[10px] px-3 py-1 border-b border-gray-200 flex items-center justify-center gap-1">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                  <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                </svg>
                <span>Copy/paste/screenshot disabled for data protection (DPA 2012)</span>
              </div>

              {/* Chat Messages */}
              <div 
                ref={chatMessagesRef}
                className="chat-messages p-4 overflow-y-auto flex-grow select-none"
                style={{ 
                  userSelect: 'none', 
                  WebkitUserSelect: 'none', 
                  MozUserSelect: 'none',
                  msUserSelect: 'none'
                }}
              >
                {isLoadingMessages ? (
                  <p className="text-center text-gray-500">Loading messages...</p>
                ) : (
                  messages.map((msg, index) => (
                    <div
                      key={msg.id || msg.tempId || index}
                      className="message-item mb-4"
                    >
                      <AdminMessageItem 
                        message={msg} 
                        sender={msg.sender} 
                        isLatest={index === messages.length - 1}
                      />
                    </div>
                  ))
                )}

                {/* Typing Indicator */}
                {typingIndicator && (
                  <p className="typing-indicator text-sm text-gray-600 italic mb-2">
                    {typingIndicator}
                  </p>
                )}
              </div>

              {/* Attached image preview (mirrors the guest chat box) */}
              {media && mediaPreviewUrl && (
                <div className="px-4 pt-2 border-t flex items-center gap-3">
                  <img
                    src={mediaPreviewUrl}
                    alt="attachment preview"
                    className="h-16 w-16 object-cover rounded border"
                  />
                  <span className="text-sm text-gray-600 truncate max-w-[200px]">
                    {media.name}
                  </span>
                  <button
                    type="button"
                    title="Remove attachment"
                    className="ml-auto text-gray-500 hover:text-red-600 text-xl leading-none px-2"
                    onClick={() => {
                      setMedia(null);
                      if (inputFileRef.current) inputFileRef.current.value = "";
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {/* Admin Input */}
              <div className="chat-input-container p-4 border-t flex items-center">
                <label
                  className={`flex-shrink-0 p-2 mr-1 rounded ${
                    !selectedChat || isOptimizingImage
                      ? "opacity-30 cursor-not-allowed"
                      : "hover:bg-gray-100 cursor-pointer"
                  }`}
                  title="Attach image"
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
                    disabled={!selectedChat || isOptimizingImage}
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      // PERF4-6 parity with the guest box: downscale +
                      // recompress client-side before upload.
                      setIsOptimizingImage(true);
                      try {
                        const optimized = await optimizeImage(file, {
                          maxWidth: 1600,
                          maxHeight: 1600,
                          quality: 0.82,
                        });
                        setMedia(optimized);
                      } catch (err) {
                        console.warn(
                          "[ADMIN] image optimize failed; sending original:",
                          err?.message
                        );
                        setMedia(file);
                      } finally {
                        setIsOptimizingImage(false);
                      }
                    }}
                  />
                </label>
                <input
                  type="text"
                  value={newMessage}
                  placeholder="Type your reply…"
                  className="flex-grow p-2 border rounded"
                  onChange={(e) => {
                    const txt = e.target.value;
                    setNewMessage(txt);
                    if (!selectedChat) return;

                    // send “typing = true” on every keystroke
                    emitTyping(selectedChat.guestId, branchEmail, true);

                    // debounce “typing = false” after 1s of no input
                    clearTimeout(typingTimeout.current);
                    typingTimeout.current = setTimeout(() => {
                      emitTyping(selectedChat.guestId, branchEmail, false);
                    }, 1000);
                  }}
                  onBlur={() => {
                    if (selectedChat) {
                      // clear indicator when input loses focus
                      emitTyping(selectedChat.guestId, branchEmail, false);
                    }
                  }}
                />
                <button
                  onClick={handleSendMessage}
                  className={`send-btn ml-2 px-4 py-2 rounded-lg ${
                    (!newMessage && !media) || !selectedChat || isOptimizingImage
                      ? "bg-gray-400 text-white cursor-not-allowed"
                      : "bg-blue-500 text-white hover:bg-blue-600"
                  }`}
                  disabled={(!newMessage && !media) || !selectedChat || isOptimizingImage}
                >
                  {isOptimizingImage ? "Optimizing…" : "Send"}
                </button>
              </div>
            </>
          ) : activeTab === "chats" && activeGuestIds.size === 0 ? (
            <div className="flex items-center justify-center flex-grow text-gray-400 text-center px-4">
              <p className="text-base italic">
                No active guest chats at the moment.
              </p>
            </div>
          ) : activeTab === "chats" ? (
            <div className="flex items-center justify-center flex-grow text-gray-500 text-center px-4">
              <p className="text-base">
                Select a chat from the left panel to view the conversation.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {/* MFA Session Verification Modal */}
      <MFASessionModal
        isOpen={showMFASession}
        onVerify={(data) => {
          setShowMFASession(false);
          // Update context to mark MFA as verified
          if (completeMFAVerification) {
            completeMFAVerification();
          }
          // Allow chat access
          console.info('[MFA] Session verified, allowing chat access');
        }}
        onCancel={() => {
          setShowMFASession(false);
          // Logout if MFA session verification is cancelled
          handleLogout();
        }}
        operation="access chat with sensitive personal information"
      />
    </div>
  );
};

export default BranchChatDashboard;
