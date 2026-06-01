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
} from "../components/Admin-Utils-socket";
import AdminMessageItem from "../components/Admin-Message-Item-Component";
import AdminNavigation from "../components/AdminNavigation-Component";
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
import { useWakeLock } from "../utils/useWakeLock";
import "./Branch-Chat-Dashboard.css";
import MFASessionModal from "../components/MFASessionModal";
import {
  initializeE2EE,
  completeKeyExchange,
  isE2EEEstablished,
  getMyPublicKey,
  e2eeEncrypt,
  e2eeDecrypt,
  clearE2EE,
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
// MESSAGE SENDING HELPERS
// ============================================================================

/**
 * Create optimistic message object
 */
const createOptimisticMessage = (guestId, branchEmail, content) => ({
  guestId,
  branchEmail,
  sender: "branch",
  content,
  message: content,
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
      messagesByGuest[msg.guestId] = {
        guestId: msg.guestId,
        guestName: msg.guestName || `Guest ${msg.guestId.slice(-4)}`,
        lastMessage: isEncrypted ? "[Encrypted message]" : (msg.content || "[media]"),
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
const persistChatState = (branchEmail, chats, activeGuestIds) => {
  clearTimeout(window.__CHAT_STORAGE_DEBOUNCE__);
  window.__CHAT_STORAGE_DEBOUNCE__ = setTimeout(() => {
    localStorage.setItem(
      `branchChats-${branchEmail}`,
      JSON.stringify({
        version: LOCAL_STORAGE_VERSION,
        chats,
        activeGuestIds: [...activeGuestIds],
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
  const [activeGuestIds, setActiveGuestIds] = useState(new Set());

  // E2EE state per guest
  const [e2eeStatus, setE2eeStatus] = useState({}); // { guestId: "initializing" | "exchanging" | "established" | "failed" }
  const [e2eeErrors, setE2eeErrors] = useState({}); // { guestId: errorMessage }

  // MFA Session State (works with Firebase MFA)
  const [showMFASession, setShowMFASession] = useState(false);
  const [mfaSessionChecked, setMfaSessionChecked] = useState(false);

  // Transcript inbox
  const [activeTab, setActiveTab] = useState("chats"); // "chats" | "email"
  const [transcripts, setTranscripts] = useState([]);
  const [isLoadingTranscripts, setIsLoadingTranscripts] = useState(false);
  const [expandedTranscriptId, setExpandedTranscriptId] = useState(null);

  const [transcriptReply, setTranscriptReply] = useState("");
  const [transcriptReplyStatus, setTranscriptReplyStatus] = useState(null);
  const [isSendingReply, setIsSendingReply] = useState(false);
  const transcriptThreadRef = useRef(null);
  const chatMessagesRef = useRef(null);

  // Pending inquiries
  const [inquiries, setInquiries] = useState([]);
  const [isLoadingInquiries, setIsLoadingInquiries] = useState(false);
  const [selectedInquiry, setSelectedInquiry] = useState(null);
  const [inquiryReply, setInquiryReply] = useState("");
  const [inquiryReplyStatus, setInquiryReplyStatus] = useState(null);
  const [isSendingInquiryReply, setIsSendingInquiryReply] = useState(false);

  const fetchInquiries = useCallback(async () => {
    setIsLoadingInquiries(true);
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/pending-inquiries`, {
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) setInquiries(data.inquiries || []);
    } catch (err) {
      console.error("[INQUIRIES]", err);
    } finally {
      setIsLoadingInquiries(false);
    }
  }, []);

  const sendInquiryReply = async () => {
    if (isSendingInquiryReply || !inquiryReply.trim() || !selectedInquiry) return;
    setIsSendingInquiryReply(true);
    setInquiryReplyStatus(null);
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/reply-transcript`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestEmail: selectedInquiry.guestEmail,
          guestName: selectedInquiry.guestName,
          replyText: inquiryReply,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      await fetch(`${process.env.REACT_APP_API_URL}/api/guest/pending-inquiries/${selectedInquiry.id}/read`, {
        method: "PATCH",
        credentials: "include",
      });
      setInquiryReplyStatus("sent");
      setInquiryReply("");
      setInquiries(prev => prev.map(i => i.id === selectedInquiry.id ? { ...i, status: "read" } : i));
    } catch {
      setInquiryReplyStatus("error");
    } finally {
      setIsSendingInquiryReply(false);
    }
  };

  const parseTranscriptLog = (log) => {
    const lines = log.split("\n");
    const messages = [];
    for (const line of lines) {
      const match = line.match(/^\[(.+?)\] (You|Support): (.+)$/);
      if (match) {
        messages.push({ time: match[1], sender: match[2], text: match[3] });
      }
    }
    return messages;
  };

  const sendTranscriptReply = async (guestEmail, guestName) => {
    if (!transcriptReply.trim() || isSendingReply) return;
    setIsSendingReply(true);
    setTranscriptReplyStatus(null);
    try {
      const token = localStorage.getItem("adminToken");
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/reply-transcript`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ guestEmail, guestName, replyText: transcriptReply }),
      });
      const data = await res.json();
      if (res.ok) {
        setTranscriptReplyStatus("sent");
        setTranscriptReply("");
      } else {
        throw new Error(data.error || "Failed");
      }
    } catch {
      setTranscriptReplyStatus("error");
    } finally {
      setIsSendingReply(false);
    }
  };

  const transcriptGroupList = useMemo(() => {
    const groups = transcripts.reduce((acc, t) => {
      const key = t.email || t.guestId;
      if (!acc[key]) acc[key] = { name: t.name, email: t.email, items: [] };
      acc[key].items.push(t);
      return acc;
    }, {});
    return Object.entries(groups).sort(
      (a, b) => new Date(b[1].items[0].sentAt) - new Date(a[1].items[0].sentAt)
    );
  }, [transcripts]);

  useEffect(() => {
    if (expandedTranscriptId && transcriptThreadRef.current) {
      transcriptThreadRef.current.scrollTop = transcriptThreadRef.current.scrollHeight;
    }
  }, [expandedTranscriptId]);

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
  // E2EE KEY EXCHANGE
  // ============================================================================
  useEffect(() => {
    if (!selectedChat?.guestId || !branchEmail) return;
    
    const guestId = selectedChat.guestId;

    // If a secure session for this guest is already established (or being
    // exchanged) by the global guest_key handler, do NOT re-initialize — that
    // would overwrite the keypair and destroy the shared key, leaving the admin
    // unable to decrypt the guest's messages.
    if (isE2EEEstablished(guestId) || e2eeStatus[guestId] === "established") {
      return;
    }
    
    // Initialize E2EE for this guest (only if not already set up)
    const initE2EE = async () => {
      try {
        if (isE2EEEstablished(guestId)) return;
        setE2eeStatus(prev => ({ ...prev, [guestId]: prev[guestId] || "initializing" }));
        await initializeE2EE(guestId);
        console.log(`[E2EE] Initialized for guest ${guestId}, waiting for guest key...`);
      } catch (error) {
        console.error(`[E2EE] Initialization failed for ${guestId}:`, error);
        setE2eeStatus(prev => ({ ...prev, [guestId]: "failed" }));
        setE2eeErrors(prev => ({ ...prev, [guestId]: error.message }));
      }
    };
    
    initE2EE();

    // NOTE: do NOT clearE2EE here. Switching chats must not tear down an
    // established session — keys are session-scoped and cleared on unmount/logout.
  }, [selectedChat?.guestId, branchEmail]);

  // ============================================================================
  // GLOBAL E2EE LISTENER (for all guests, not just selected)
  // ============================================================================
  useEffect(() => {
    if (!branchEmail || !socketInstance) return;
    
    // Listen for guest's public key (for all guests, not just selected)
    const handleGuestKey = async (data) => {
      console.log(`[E2EE] DEBUG: Received guest key event:`, data);
      const { guestId: incomingGuestId, publicKey } = data;
      if (!incomingGuestId || !publicKey) {
        console.log(`[E2EE] DEBUG: Missing guestId or publicKey`);
        return;
      }
      
      // Only process if it's for our branch
      if (data.branchEmail && data.branchEmail !== branchEmail) {
        console.log(`[E2EE] DEBUG: Key not for our branch (${data.branchEmail} != ${branchEmail})`);
        return;
      }
      
      try {
        console.log(`[E2EE] Received key from guest ${incomingGuestId}`);
        
        // Initialize E2EE for this guest if not already done
        if (!e2eeStatus[incomingGuestId]) {
          setE2eeStatus(prev => ({ ...prev, [incomingGuestId]: "initializing" }));
          await initializeE2EE(incomingGuestId);
        }
        
        setE2eeStatus(prev => ({ ...prev, [incomingGuestId]: "exchanging" }));
        await completeKeyExchange(incomingGuestId, publicKey);
        
        // Send our public key back to the guest
        const myPublicKey = await getMyPublicKey(incomingGuestId);
        if (myPublicKey) {
          socketInstance.emit("e2ee:branch_key", {
            guestId: incomingGuestId,
            branchEmail,
            publicKey: myPublicKey,
            role: "branch",
          });
          console.log(`[E2EE] Sent branch key to guest ${incomingGuestId}`);
        }
        
        setE2eeStatus(prev => ({ ...prev, [incomingGuestId]: "established" }));
        console.log(`[E2EE] Secure channel established with guest ${incomingGuestId}`);
      } catch (error) {
        console.error(`[E2EE] Key exchange failed for ${incomingGuestId}:`, error);
        setE2eeStatus(prev => ({ ...prev, [incomingGuestId]: "failed" }));
        setE2eeErrors(prev => ({ ...prev, [incomingGuestId]: error.message }));
      }
    };
    
    socketInstance.off("e2ee:guest_key", handleGuestKey);
    socketInstance.on("e2ee:guest_key", handleGuestKey);
    console.log(`[E2EE] DEBUG: Bound handleGuestKey to socket ${socketInstance.id}`);
    
    return () => {
      socketInstance.off("e2ee:guest_key", handleGuestKey);
    };
  }, [branchEmail, socketInstance?.id]);

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

  useEffect(() => {
    const unsubscribe = onUnreadUpdate(({ guestId, unreadCount }) => {
      setUnreadCounts((prev) => ({
        ...prev,
        [guestId]: unreadCount,
      }));
    });
    return unsubscribe;
  }, []);

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
  // TRANSCRIPT FETCHING
  // ============================================================================
  const fetchTranscripts = useCallback(async () => {
    const token = sessionStorage.getItem("branchAdminToken");
    if (!token || !branchEmail) return;
    setIsLoadingTranscripts(true);
    try {
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/api/guest/chat-logs`,
        {
          method: "GET",
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const data = await res.json();
      if (res.ok) {
        setTranscripts(data.logs || []);
      } else {
        console.error("[TRANSCRIPTS] ❌ Failed:", data.error);
      }
    } catch (err) {
      console.error("[TRANSCRIPTS] ❌", err.message);
    } finally {
      setIsLoadingTranscripts(false);
    }
  }, [branchEmail]);

  // Fetch transcripts when tab becomes active
  useEffect(() => {
    if (activeTab === "transcripts" && hydrated) {
      fetchTranscripts();
    }
    if (activeTab === "email") {
      fetchTranscripts();
      fetchInquiries();
    }
  }, [activeTab, hydrated, fetchTranscripts, fetchInquiries]);

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
      persistChatState(branchEmail, chatsRef.current, activeIdsRef.current);

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
          if (m.e2ee && m.content && isE2EEEstablished(guestId)) {
            try {
              const payload = JSON.parse(m.content);
              if (payload.ciphertext && payload.iv) {
                const plain = await e2eeDecrypt(guestId, payload.ciphertext, payload.iv);
                return { ...m, content: plain, message: plain, encrypted: true };
              }
            } catch (e) {
              return { ...m, content: "[Encrypted message]", message: "[Encrypted message]", encrypted: true };
            }
          }
          // Encrypted but no key available (e.g. older session) → don't show raw ciphertext.
          if (m.e2ee && typeof m.content === "string" && m.content.includes('"ciphertext"')) {
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
           2️⃣  MERGE active-guest-ids
        ----------------------------------------------------------------- */
        if (Array.isArray(payload?.activeGuestIds)) {
          setActiveGuestIds((prev) => {
            const merged = new Set(prev);
            payload.activeGuestIds.forEach((id) => merged.add(id));
            activeIdsRef.current = merged;
            return merged; // new reference → sidebar re-renders
          });
        }

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
        .filter((c) => !closedChats[c.guestId] && !c.archived) // drop ghosts
        .sort((a, b) => a.guestId.localeCompare(b.guestId)), // stable sort
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
      await connectSocket(branchEmail); // passive
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

    // ➤ Always apply presence updates; also refetch chats to pick up new guests
    const handlePresenceUpdate = async (ids) => {
      // 1️⃣ Ignore empty arrays
      if (!Array.isArray(ids) || ids.length === 0) {
        console.log("[PRESENCE] Ignoring empty guestPresenceUpdate:", ids);
        return;
      }
      // 2️⃣ Skip updates while window is hidden
      if (document.visibilityState !== "visible") {
        console.log("[PRESENCE] Window hidden – skipping guestPresenceUpdate:", ids);
        return;
      }
      // 3️⃣ Apply the presence set
      setActiveGuestIds(new Set(ids));
      // 4️⃣ And refresh the chat list so any brand-new guest threads appear
      try {
        await fetchActiveChats();
      } catch (err) {
        console.warn("[PRESENCE] fetchActiveChats failed:", err.message);
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
          activeGuestIds: [...newIds],
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

        if (payload?.activeGuestIds) {
          const set = new Set(payload.activeGuestIds);
          setActiveGuestIds(set);
          activeIdsRef.current = set;
        }

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
                const msgs = snapshot.docs
                  .map((doc) => ({ id: doc.id, ...doc.data() }))
                  .filter((msg) => msg.archived !== true);
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

      // 1. Create an optimistic message (show plaintext locally)
      const optimisticMessage = createOptimisticMessage(guestId, branchEmail, newMessage);
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
        setMessages((prev) =>
          prev.map((msg) => (msg.tempId === optimisticMessage.tempId ? savedMessage : msg))
        );
        console.log(
          "[ADMIN] ✅ Message confirmed by server and UI updated:",
          savedMessage
        );

        // 5. WebSocket emit (send plaintext for real-time delivery, backend already has encrypted copy)
        sendMessage({
          room: `guest-${guestId}`,
          guestId,
          content: newMessage, // Send plaintext for socket (E2EE already in DB)
          sender: "branch",
          id: savedMessage.id,
          timestamp: savedMessage.timestamp,
          e2ee: !!encryptedPayload,
          encryptedContent: encryptedPayload,
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

  //🔹 Secure Logout Button Component
  const AdminLogoutButton = () => (
    <div
      style={{ display: "flex", justifyContent: "center", marginTop: "20px" }}
    >
      <button
        onClick={handleLogout}
        style={{
          padding: "10px 20px",
          backgroundColor: "#e53e3e",
          color: "white",
          fontSize: "16px",
          border: "none",
          borderRadius: "5px",
          cursor: "pointer",
        }}
      >
        Logout
      </button>
    </div>
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

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="w-full bg-gray-800 text-white p-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Branch Chat Dashboard</h1>
          <AdminNavigation currentPage="/admin/chats" />
        </div>
        {isAuthenticated && <AdminLogoutButton />}
      </div>

      <div className="flex flex-row flex-grow overflow-hidden">
        {/* Sidebar */}
        <div className="w-1/3 bg-gray-100 border-r flex flex-col">
          {/* Active Chats list */}
          {(
            <div className="overflow-y-auto flex-grow">
              {sortedActiveChats.length === 0 ? (
                <p className="text-sm text-gray-500 px-4 py-4 italic">
                  No active guest chats at the moment.
                </p>
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

        {/* Main Chat View / Transcript Viewer */}
        <div className="w-2/3 flex flex-col">

          {false && (() => {
            const group = transcriptGroupList.find(([k]) => k === expandedTranscriptId)?.[1];
            if (!group) return null;
            return (
              <div className="flex flex-col flex-grow overflow-hidden">
                {/* Thread header */}
                <div className="px-6 py-4 border-b bg-white flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-gray-900">{group.name}</p>
                    {group.email && <p className="text-sm text-gray-500">{group.email}</p>}
                  </div>
                  <span className="text-xs text-gray-400">{group.items.length} session{group.items.length !== 1 ? "s" : ""}</span>
                </div>
                {/* Thread messages */}
                <div ref={transcriptThreadRef} className="overflow-y-auto flex-grow px-6 py-4 space-y-8 bg-gray-50">
                  {[...group.items].reverse().map((t, idx, arr) => {
                    const msgs = parseTranscriptLog(t.log);
                    const thisDate = t.sentAt ? new Date(t.sentAt).toDateString() : null;
                    const prevDate = idx > 0 && arr[idx - 1].sentAt ? new Date(arr[idx - 1].sentAt).toDateString() : null;
                    const sameDay = thisDate && thisDate === prevDate;
                    const dividerLabel = t.sentAt
                      ? sameDay
                        ? new Date(t.sentAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
                        : new Date(t.sentAt).toLocaleString("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
                      : "—";
                    return (
                      <div key={t.id}>
                        {sameDay ? (
                          <div className="flex justify-center mb-3">
                            <span className="text-xs text-gray-400">{dividerLabel}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3 mb-3">
                            <div className="flex-grow border-t border-gray-200" />
                            <span className="text-xs text-gray-400 shrink-0">{dividerLabel}</span>
                            <div className="flex-grow border-t border-gray-200" />
                          </div>
                        )}
                        {msgs.length > 0 ? (
                          <div className="space-y-2">
                            {msgs.map((m, i) => (
                              <div key={i} className={`flex ${m.sender === "You" ? "justify-start" : "justify-end"}`}>
                                <div className={`max-w-[75%] px-4 py-2 rounded-2xl text-sm ${
                                  m.sender === "You"
                                    ? "bg-white border text-gray-800 rounded-tl-sm"
                                    : "bg-blue-500 text-white rounded-tr-sm"
                                }`}>
                                  <p>{m.text}</p>
                                  <p className={`text-xs mt-1 ${m.sender === "You" ? "text-gray-400" : "text-blue-100"}`}>{m.time}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <pre className="text-xs text-gray-500 whitespace-pre-wrap break-words font-mono bg-white rounded p-3 border">
                            {t.log}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Reply box */}
                <div className="border-t bg-white px-6 py-4">
                  {transcriptReplyStatus === "sent" && (
                    <p className="text-xs text-green-600 mb-2">✅ Reply sent to {group.email}</p>
                  )}
                  {transcriptReplyStatus === "error" && (
                    <p className="text-xs text-red-500 mb-2">❌ Failed to send. Try again.</p>
                  )}
                  <div className="flex gap-2 items-end">
                    <textarea
                      rows={2}
                      className="flex-grow border rounded-lg p-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-300"
                      placeholder={`Reply to ${group.email || group.name}…`}
                      value={transcriptReply}
                      onChange={(e) => { setTranscriptReply(e.target.value); setTranscriptReplyStatus(null); }}
                      disabled={isSendingReply}
                    />
                    <button
                      onClick={() => sendTranscriptReply(group.email, group.name)}
                      disabled={isSendingReply || !transcriptReply.trim()}
                      className="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSendingReply ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
          {activeTab === "chats" && selectedChat ? (
            <>
              {/* E2EE Security Status */}
              {e2eeStatus[selectedChat.guestId] === "established" ? (
                <div className="bg-green-50 text-green-700 text-[10px] px-3 py-1 border-b border-green-200 flex items-center justify-center gap-1">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z"/>
                  </svg>
                  <span>End-to-end encrypted (AES-256-GCM)</span>
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

              {/* Admin Input */}
              <div className="chat-input-container p-4 border-t flex items-center">
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
                    !newMessage || !selectedChat
                      ? "bg-gray-400 text-white cursor-not-allowed"
                      : "bg-blue-500 text-white hover:bg-blue-600"
                  }`}
                  disabled={!newMessage || !selectedChat}
                >
                  Send
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
