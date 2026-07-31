import React, { useState, useEffect, useRef, useCallback } from "react";
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
  onConnectionStatus,
  sendMessage,
} from "../Shared/User-Utils-socket";
import MessageItem from "../Shared/Message-Item-Component";
import { optimizeImage } from "../Shared/Utils-imageOptimization";
import "./Guest-Chat-Box-Component.css";
import GuestIdleNotice from "./Guest-Idle-Notice-Component";
import TranscriptModal from "../components/TranscriptModal";
import GuestConfirmDialog from "../components/Guest-Confirm-Dialog";
import {
  isE2EEEstablished,
  e2eeEncrypt,
  e2eeDecrypt,
  establishWithServerKey,
} from "../utils/e2eeCrypto";

const socket = getSocketInstance();

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_RETRIES = 5;
const BACKOFF_MS = 1000;
const DEBOUNCE_MS = 1000;
const OFFLINE_BANNER_DELAY_MS = 5000;
const STATUS_DEBOUNCE_MS = 1000;
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate temporary message ID
 */
const generateTempId = () =>
  "temp-" + Date.now() + "-" + Math.random().toString(36).substring(2, 10);

/**
 * Generate client message ID (UUID or fallback)
 */
const generateClientMessageId = () =>
  (window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `cm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * Generate cache key for message storage
 */
const getCacheKey = (guestId, branchId) => `chatMessages-${guestId}-${branchId}`;

/**
 * Decode JWT payload
 */
function parseJwt(token) {
  try {
    const b = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Debounce function
 */
function debounce(fn, ms = DEBOUNCE_MS) {
  let timer;
  function wrapper(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }
  wrapper.cancel = () => {
    clearTimeout(timer);
  };
  return wrapper;
}

// ============================================================================
// SENSITIVE DATA DETECTION
// ============================================================================

const SENSITIVE_PATTERNS = [
  { name: 'Credit Card', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/, icon: '💳' },
  { name: 'Bank Account', regex: /\b\d{10,16}\b/, icon: '🏦' },
  { name: 'Password', regex: /password[:=\s]+\S+/i, icon: '🔑' },
  { name: 'PIN', regex: /\bPIN\s*[:=]?\s*\d{4,6}\b/i, icon: '🔢' },
  { name: 'API Key', regex: /(?:api[_-]?key|token|secret)[:=\s]+[a-zA-Z0-9]{16,}/i, icon: '🔐' },
  
  // Philippine phone numbers - mobile, landline, with various formats
  { name: 'PH Mobile', regex: /\b(?:\+63|0)9\d{9}\b/, icon: '📱' },
  { name: 'PH Landline', regex: /\b(?:\+63|0)?\(?0?2\)?[-.\s]?\d{7,8}\b/, icon: '📞' },
  { name: 'PH Trunk Line', regex: /\b\d{3}[-.\s]?\d{4}\b/, icon: '📠' },
  
  // Pawnshop specific - Pawn Ticket Numbers (alphanumeric, varying lengths)
  // Matches: PTN123456, SGL-A1B2C3, TKT-2024-001234, P-12345, etc.
  // The identifier must contain at least one digit — otherwise the bare "p"/
  // "pawn" prefixes match ordinary words ("please", "pawnshop") and the
  // security review interrupts normal conversation (UAT F-G1).
  { name: 'Pawn Ticket', regex: /\b(?:ptn|pt|pkt|ticket|tkt|sangla|sgl|pawn|p)[-#:\s]*(?=[A-Z]*\d)[A-Z0-9]{4,15}\b/i, icon: '🎫' },
  { name: 'Item Value', regex: /\b(?:value|amount|appraisal)[\s:]*[\d,]+(?:\.\d{2})?\b/i, icon: '💰' },
  
  // ============================================================================
  // PHILIPPINE GOVERNMENT IDs - Comprehensive Coverage
  // ============================================================================
  
  // SSS Number - 10 digits, various formats
  { name: 'SSS Number', regex: /\b(?:sss#?|sss\s*(?:no|number|id)?)[:\s-]*\d{2}?[-]?\d{7}[-]?\d{1}?\b/i, icon: '🆔' },
  { name: 'SSS Number (10 digit)', regex: /\b\d{10}\b(?![\d-])/, icon: '🆔' },
  
  // GSIS ID - 11 digits or BP prefix
  { name: 'GSIS ID', regex: /\b(?:gsis#?|gsis\s*(?:no|number|id)?)[:\s-]*(?:bp)?\d{8,11}\b/i, icon: '🆔' },
  { name: 'GSIS ID (BP)', regex: /\bBP\d{8,11}\b/i, icon: '🆔' },
  
  // TIN - Tax Identification Number (9-12 digits)
  { name: 'TIN', regex: /\b(?:tin#?|tin\s*(?:no|number|id)?)[:\s-]*\d{3}[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{0,3}\b/i, icon: '🆔' },
  { name: 'TIN (9-12 digit)', regex: /\b\d{3}[-\s]\d{3}[-\s]\d{3}(?:[-\s]\d{3})?\b/, icon: '🆔' },
  
  // PhilHealth - 12 digits (NNNN-NNNNNNNN-N)
  { name: 'PhilHealth', regex: /\b(?:philhealth|ph|phic)[#:\s-]*\d{4}[-\s]?\d{8,9}[-\s]?\d?\b/i, icon: '🏥' },
  { name: 'PhilHealth (12 digit)', regex: /\b\d{4}[-\s]\d{8}[-\s]\d\b/, icon: '🏥' },
  
  // PAG-IBIG / HDMF - 12 digits
  { name: 'PAG-IBIG', regex: /\b(?:pag-?ibig|hdmf|mid)[#:\s-]*\d{12}\b/i, icon: '🏠' },
  { name: 'PAG-IBIG (12 digit)', regex: /\b\d{12}\b(?=[^\d-]|$)/, icon: '🏠' },
  
  // UMID - Unified Multi-purpose ID
  { name: 'UMID', regex: /\b(?:umid|sss-umid|gsis-umid)[#:\s-]*[A-Z]{2,4}[-\s]?\d{10,12}\b/i, icon: '🆔' },
  
  // Driver's License - Various formats
  { name: 'Driver\'s License', regex: /\b(?:dl|license)[#:\s-]*[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{5,6}\b/i, icon: '🚗' },
  { name: 'Driver\'s License (N)', regex: /\bN\d{2}[-\s]?\d{2}[-\s]?\d{5,6}\b/i, icon: '🚗' },
  { name: 'Driver\'s License (New)', regex: /\b[A-Z]\d{10}\b/i, icon: '🚗' },
  
  // Passport - 9 alphanumeric
  { name: 'Passport', regex: /\b(?:passport|pp)[#:\s-]*[A-Z]{1,2}\d{6,7}[A-Z]?\b/i, icon: '🌐' },
  { name: 'Passport (9 char)', regex: /\b[A-Z]\d{7}[A-Z]?\b|\b[A-Z]{2}\d{6}\b/, icon: '🌐' },
  
  // PRC License - 7 digits
  { name: 'PRC License', regex: /\b(?:prc)[#:\s-]*\d{7}\b/i, icon: '👨‍⚕️' },
  { name: 'PRC (7 digit)', regex: /\b\d{7}\b(?![\d])/, icon: '👨‍⚕️' },
  
  // Voter's ID (COMELEC) - 18 digits
  { name: 'Voter\'s ID', regex: /\b(?:voter|comelec|voter's)[#:\s-]*\d{18,20}\b/i, icon: '🗳️' },
  { name: 'Voter ID (18+ digit)', regex: /\b\d{18,20}\b/, icon: '🗳️' },
  
  // Postal ID - 10+ digits
  { name: 'Postal ID', regex: /\b(?:postal|pid)[#:\s-]*\d{10,16}\b/i, icon: '📮' },
  
  // NBI Clearance
  { name: 'NBI Clearance', regex: /\b(?:nbi)[#:\s-]*[A-Z]?\d{8,12}\b/i, icon: '🔍' },
  
  // Police Clearance
  { name: 'Police Clearance', regex: /\b(?:police|pc)[#:\s-]*[A-Z]{2,3}[-\s]?\d{5,8}\b/i, icon: '👮' },
  
  // Barangay ID
  { name: 'Barangay ID', regex: /\b(?:brgy|barangay)[#:\s-]*\d{6,10}\b/i, icon: '🏘️' },
  
  // Senior Citizen ID
  { name: 'Senior Citizen ID', regex: /\b(?:senior|sc)[#:\s-]*(?:sc)?[-\s]?\d{4}[-\s]?\d{6,8}\b/i, icon: '👴' },
  { name: 'Senior Citizen (OSCA)', regex: /\bOSCA[-\s]?\d{4}[-\s]?\d{6}\b/i, icon: '👴' },
  
  // PWD ID
  { name: 'PWD ID', regex: /\b(?:pwd)[#:\s-]*[A-Z]{2,3}[-\s]?\d{6,8}\b/i, icon: '♿' },
  
  // OFW ID / OWWA
  { name: 'OFW ID', regex: /\b(?:ofw|owwa)[#:\s-]*\d{9,12}\b/i, icon: '✈️' },
  
  // 4Ps ID (DSWD)
  { name: '4Ps ID', regex: /\b(?:4ps|hh)[#:\s-]*\d{10,12}\b/i, icon: '🏛️' },
  
  // Seaman's Book
  { name: 'Seaman\'s Book', regex: /\b(?:seaman|sb)[#:\s-]*[A-Z]?\d{6,10}\b/i, icon: '⚓' },
  { name: 'Seaman\'s Book (S)', regex: /\bS\d{7}\b/, icon: '⚓' },
  
  // Military/Police IDs
  { name: 'AFP ID', regex: /\b(?:afp)[#:\s-]*\d{7,10}\b/i, icon: '🎖️' },
  { name: 'PNP ID', regex: /\b(?:pnp)[#:\s-]*\d{6,8}\b/i, icon: '👮‍♂️' },
  
  // IBP (Lawyer)
  { name: 'IBP Roll', regex: /\b(?:ibp)[#:\s-]*\d{5,7}\b/i, icon: '⚖️' },
  
  // BALIK MANGGAGAWA
  { name: 'Balik Manggagawa', regex: /\b(?:bm|balik)[#:\s-]*\d{9,12}\b/i, icon: '✈️' },
  
  // Private/Company IDs
  { name: 'Company ID', regex: /\b(?:emp|employee|staff|id#)[#:\s-]*\d{5,10}\b/i, icon: '💼' },
  { name: 'Student ID', regex: /\b(?:student|sch|school)[#:\s-]*\d{4}[-\s]?\d{4,6}\b/i, icon: '🎓' },
  
  // Insurance & Financial
  { name: 'Insurance Policy', regex: /\b(?:pl|policy|ins)[#:\s-]*[A-Z]{2,4}[-\s]?\d{6,10}\b/i, icon: '📄' },
  { name: 'Membership ID', regex: /\b(?:mem|member|vip)[#:\s-]*\d{4}[-\s]?\d{4,6}\b/i, icon: '💳' },
];

// Pawnshop business context + sensitive financial terms
const SENSITIVE_KEYWORDS = [
  // Financial sensitive
  'payment', 'card', 'credit', 'debit', 'bank', 'account', 'password', 'pin', 'otp', 'cvv', 'secret',
  // Philippine pawnshop operations
  'sangla', 'tubos', 'renewal', 'subasta', 'pawn', 'collateral', 'appraisal', 'valuation',
  'interest', 'principal', 'maturity', 'due date', 'redemption', 'foreclosure',
  // Personal info
  'address', 'birthday', 'birthdate', 'id number', 'passport', 'license', 'sss', 'tin', 'umid',
  // Communication
  'call me', 'text me', 'sms', 'viber', 'whatsapp', 'telegram', 'facebook', 'messenger'
];

function detectSensitivePatterns(text) {
  return SENSITIVE_PATTERNS.filter(p => p.regex.test(text));
}

function isSensitiveTopic(text) {
  const lower = text.toLowerCase();
  return SENSITIVE_KEYWORDS.some(kw => lower.includes(kw));
}

function maskSensitiveData(text) {
  let masked = text;
  // Credit cards
  masked = masked.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '****-****-****-****');
  // Bank accounts
  masked = masked.replace(/\b\d{10,16}\b/g, (m) => m.slice(0, 4) + '****' + m.slice(-4));
  // Passwords
  masked = masked.replace(/password[:=\s]+\S+/gi, 'password: [REDACTED]');
  // PINs
  masked = masked.replace(/\bPIN\s*[:=]?\s*\d{4,6}\b/gi, 'PIN: [REDACTED]');
  // PH Mobile numbers
  masked = masked.replace(/\b(?:\+63|0)9\d{9}\b/g, '[MOBILE-REDACTED]');
  // PH Landline numbers
  masked = masked.replace(/\b(?:\+63|0)?\(?0?2\)?[-.\s]?\d{7,8}\b/g, '[LANDLINE-REDACTED]');
  // PH Trunk lines (3-4 digits, could be office extensions)
  masked = masked.replace(/\b\d{3}[-.\s]?\d{4}\b/g, '[EXTENSION-REDACTED]');
  // Pawn Ticket Numbers (alphanumeric formats; digit required — see
  // SENSITIVE_PATTERNS note)
  masked = masked.replace(/\b(?:ptn|pt|pkt|ticket|tkt|sangla|sgl|pawn|p)[-#:\s]*(?=[A-Z]*\d)[A-Z0-9]{4,15}\b/gi, '[PAWNTICKET-REDACTED]');
  // API keys
  masked = masked.replace(/(?:api[_-]?key|token|secret)[:=\s]+[a-zA-Z0-9]{16,}/gi, '[API-KEY-REDACTED]');
  
  // ============================================================================
  // PHILIPPINE IDs - Mask all formats
  // ============================================================================
  // SSS Number - various formats
  masked = masked.replace(/\b(?:sss#?|sss\s*(?:no|number|id)?)[:\s-]*\d{2}?[-]?\d{7}[-]?\d{1}?\b/gi, '[SSS-REDACTED]');
  masked = masked.replace(/\b\d{10}\b(?![\d-])/g, '[ID-REDACTED]');
  // GSIS ID
  masked = masked.replace(/\b(?:gsis#?|gsis\s*(?:no|number|id)?)[:\s-]*(?:bp)?\d{8,11}\b/gi, '[GSIS-REDACTED]');
  masked = masked.replace(/\bBP\d{8,11}\b/gi, '[GSIS-REDACTED]');
  // TIN
  masked = masked.replace(/\b(?:tin#?|tin\s*(?:no|number|id)?)[:\s-]*\d{3}[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{0,3}\b/gi, '[TIN-REDACTED]');
  masked = masked.replace(/\b\d{3}[-\s]\d{3}[-\s]\d{3}(?:[-\s]\d{3})?\b/g, '[TIN-REDACTED]');
  // PhilHealth
  masked = masked.replace(/\b(?:philhealth|ph|phic)[#:\s-]*\d{4}[-\s]?\d{8,9}[-\s]?\d?\b/gi, '[PHILHEALTH-REDACTED]');
  // PAG-IBIG
  masked = masked.replace(/\b(?:pag-?ibig|hdmf|mid)[#:\s-]*\d{12}\b/gi, '[PAGIBIG-REDACTED]');
  // UMID
  masked = masked.replace(/\b(?:umid|sss-umid|gsis-umid)[#:\s-]*[A-Z]{2,4}[-\s]?\d{10,12}\b/gi, '[UMID-REDACTED]');
  // Driver's License
  masked = masked.replace(/\b(?:dl|license)[#:\s-]*[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{5,6}\b/gi, '[DRIVERLICENSE-REDACTED]');
  masked = masked.replace(/\bN\d{2}[-\s]?\d{2}[-\s]?\d{5,6}\b/g, '[DRIVERLICENSE-REDACTED]');
  masked = masked.replace(/\b[A-Z]\d{10}\b/g, '[DRIVERLICENSE-REDACTED]');
  // Passport
  masked = masked.replace(/\b(?:passport|pp)[#:\s-]*[A-Z]{1,2}\d{6,7}[A-Z]?\b/gi, '[PASSPORT-REDACTED]');
  masked = masked.replace(/\b[A-Z]\d{7}[A-Z]?\b|\b[A-Z]{2}\d{6}\b/g, '[PASSPORT-REDACTED]');
  // PRC
  masked = masked.replace(/\b(?:prc)[#:\s-]*\d{7}\b/gi, '[PRC-REDACTED]');
  // Voter's ID
  masked = masked.replace(/\b(?:voter|comelec|voter's)[#:\s-]*\d{18,20}\b/gi, '[VOTERID-REDACTED]');
  masked = masked.replace(/\b\d{18,20}\b/g, '[VOTERID-REDACTED]');
  // Postal ID
  masked = masked.replace(/\b(?:postal|pid)[#:\s-]*\d{10,16}\b/gi, '[POSTALID-REDACTED]');
  // NBI
  masked = masked.replace(/\b(?:nbi)[#:\s-]*[A-Z]?\d{8,12}\b/gi, '[NBI-REDACTED]');
  // Police Clearance
  masked = masked.replace(/\b(?:police|pc)[#:\s-]*[A-Z]{2,3}[-\s]?\d{5,8}\b/gi, '[POLICE-REDACTED]');
  // Barangay ID
  masked = masked.replace(/\b(?:brgy|barangay)[#:\s-]*\d{6,10}\b/gi, '[BARANGAYID-REDACTED]');
  // Senior Citizen
  masked = masked.replace(/\b(?:senior|sc)[#:\s-]*(?:sc)?[-\s]?\d{4}[-\s]?\d{6,8}\b/gi, '[SENIORID-REDACTED]');
  masked = masked.replace(/\bOSCA[-\s]?\d{4}[-\s]?\d{6}\b/gi, '[SENIORID-REDACTED]');
  // PWD ID
  masked = masked.replace(/\b(?:pwd)[#:\s-]*[A-Z]{2,3}[-\s]?\d{6,8}\b/gi, '[PWDID-REDACTED]');
  // OFW ID
  masked = masked.replace(/\b(?:ofw|owwa)[#:\s-]*\d{9,12}\b/gi, '[OFWID-REDACTED]');
  // 4Ps
  masked = masked.replace(/\b(?:4ps|hh)[#:\s-]*\d{10,12}\b/gi, '[4PSID-REDACTED]');
  // Seaman's Book
  masked = masked.replace(/\b(?:seaman|sb)[#:\s-]*[A-Z]?\d{6,10}\b/gi, '[SEAMANBOOK-REDACTED]');
  masked = masked.replace(/\bS\d{7}\b/g, '[SEAMANBOOK-REDACTED]');
  // AFP ID
  masked = masked.replace(/\b(?:afp)[#:\s-]*\d{7,10}\b/gi, '[AFPID-REDACTED]');
  // PNP ID
  masked = masked.replace(/\b(?:pnp)[#:\s-]*\d{6,8}\b/gi, '[PNPID-REDACTED]');
  // IBP
  masked = masked.replace(/\b(?:ibp)[#:\s-]*\d{5,7}\b/gi, '[IBP-REDACTED]');
  // Balik Manggagawa
  masked = masked.replace(/\b(?:bm|balik)[#:\s-]*\d{9,12}\b/gi, '[BALIKMANGGAGAWA-REDACTED]');
  // Company/Private IDs
  masked = masked.replace(/\b(?:emp|employee|staff|id#)[#:\s-]*\d{5,10}\b/gi, '[EMPLOYEEID-REDACTED]');
  masked = masked.replace(/\b(?:student|sch|school)[#:\s-]*\d{4}[-\s]?\d{4,6}\b/gi, '[STUDENTID-REDACTED]');
  // Insurance & Membership
  masked = masked.replace(/\b(?:pl|policy|ins)[#:\s-]*[A-Z]{2,4}[-\s]?\d{6,10}\b/gi, '[POLICY-REDACTED]');
  masked = masked.replace(/\b(?:mem|member|vip)[#:\s-]*\d{4}[-\s]?\d{4,6}\b/gi, '[MEMBERID-REDACTED]');
  // Generic 12-digit ID fallback
  masked = masked.replace(/\b\d{12}\b(?=[^\d-]|$)/g, '[ID-REDACTED]');
  // Generic 10-digit ID fallback
  masked = masked.replace(/\b\d{10}\b/g, '[ID-REDACTED]');
  // Generic 7-digit ID fallback
  masked = masked.replace(/\b\d{7}\b(?![\d])/g, '[ID-REDACTED]');
  return masked;
}

// ============================================================================
// AUTHENTICATION HELPERS
// ============================================================================

/**
 * Fetch and cache CSRF token
 */
async function fetchCsrfToken() {
  try {
    const res = await fetch(`${process.env.REACT_APP_API_URL}/api/csrf-token`, {
      credentials: "include",
    });
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

/**
 * Ensure guest JWT is fresh with CSRF header
 */
async function ensureValidGuestToken() {
  const token = sessionStorage.getItem("guestToken");
  if (!token) throw new Error("No guest token available");
  const payload = parseJwt(token);
  if (!payload?.exp) return;

  const expiresAt = payload.exp * 1000;
  if (Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    console.log("[GUEST] ⚙️ Token near expiry, refreshing now…");
    if (!window.__CSRF_TOKEN__) {
      await fetchCsrfToken();
    }
    const res = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/refresh-token`, {
      method: "POST",
      credentials: "include",
      headers: {
        "X-CSRF-Token": window.__CSRF_TOKEN__,
        // P1-4: prior token as proof (in case the cross-site cookie is blocked).
        "Authorization": `Bearer ${sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken") || ""}`,
      },
    });
    if (!res.ok) throw new Error("Unable to refresh guest token");

    const { token: newToken } = await res.json();
    sessionStorage.setItem("guestToken", newToken);
    if (socket && socket.auth) {
      socket.auth.token = newToken;
    }

    console.log("[GUEST] ✅ Guest token refreshed and applied");
  }
}

/**
 * Check if JWT token is expired
 */
function isTokenExpired(jwt) {
  if (!jwt) return true;
  try {
    const [, payloadB64] = jwt.split(".");
    const { exp } = JSON.parse(atob(payloadB64));
    return exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

// ============================================================================
// NETWORK HELPERS
// ============================================================================

/**
 * Exponential-backoff fetch on 429 errors
 */
async function fetchWithBackoff(url, options, maxRetries = MAX_RETRIES, backoffMs = BACKOFF_MS) {
  let tries = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url, options);

      // Return immediately if not rate-limited or retries exhausted
      if (res.status !== 429 || tries >= maxRetries) {
        return res;
      }

      // Respect server's Retry-After header if present
      const retryAfter = res.headers.get("Retry-After");
      const waitTime = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : backoffMs * Math.pow(2, tries);

      // Add jitter (0-100ms) to avoid thundering herd
      const jitter = Math.random() * 100;

      await new Promise((r) => setTimeout(r, waitTime + jitter));
      tries++;
    } catch (err) {
      // Handle network failures (DNS, offline, etc.)
      if (tries >= maxRetries) throw err;
      tries++;
      // Exponential backoff for network errors too
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, tries)));
    }
  }
}

// ============================================================================
// MESSAGE HANDLING HELPERS
// ============================================================================

/**
 * Create optimistic message object
 */
const createOptimisticMessage = (guestId, branchId, branchEmail, content, media, clientMessageId) => ({
  guestId,
  branchId,
  branchEmail,
  sender: "guest",
  content,
  message: content,
  timestamp: new Date().toISOString(),
  pending: true,
  status: "sent",
  tempId: generateTempId(),
  clientMessageId,
  media: media || null,
});

/**
 * Create confirmed message object from server response
 */
const createConfirmedMessage = (savedMessage, guestId, branchId, branchEmail, content, media, tempId, clientMessageId) => ({
  ...savedMessage,
  id: savedMessage.id || clientMessageId,
  clientMessageId,
  guestId,
  branchId,
  branchEmail,
  sender: "guest",
  status: "sent",
  pending: false,
  archived: false,
  content: savedMessage.content || content,
  message: savedMessage.content || content,
  tempId,
  media: savedMessage.media || media || null,
});

/**
 * Build fetch options for message sending
 */
const buildMessageFetchOptions = (token, branchId, branchEmail, guestId, content, media, clientMessageId) => {
  const opts = {
    method: "POST",
    credentials: "include",
    headers: {},
    body: null,
  };

  if (media) {
    const form = new FormData();
    form.append("branchId", branchId);
    form.append("branchEmail", branchEmail);
    form.append("guestId", guestId);
    form.append("content", content);
    form.append("media", media);
    form.append("clientMessageId", clientMessageId);
    opts.body = form;
    if (token) opts.headers.Authorization = `Bearer ${token}`;
  } else {
    opts.headers["Content-Type"] = "application/json";
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    opts.body = JSON.stringify({
      branchId,
      branchEmail,
      guestId,
      content,
      clientMessageId,
    });
  }

  return opts;
};

/**
 * Update message in state and cache
 */
const updateMessageInState = (messages, tempId, confirmedMessage, guestId, branchId) => {
  const arr = [...messages];
  const idx = arr.findIndex((m) => m.tempId === tempId);
  if (idx > -1) arr[idx] = confirmedMessage;
  else arr.push(confirmedMessage);
  sessionStorage.setItem(getCacheKey(guestId, branchId), JSON.stringify(arr));
  return arr;
};

/**
 * Mark message as failed
 */
const markMessageAsFailed = (messages, tempId, failureReason, guestId, branchId, retryFn) => {
  const updated = [...messages];
  const idx = updated.findIndex((m) => m.tempId === tempId);
  if (idx !== -1) {
    updated[idx] = {
      ...updated[idx],
      status: "failed",
      pending: true,
      failureReason,
      retry: retryFn,
    };
  }
  sessionStorage.setItem(getCacheKey(guestId, branchId), JSON.stringify(updated));
  return updated;
};

// ============================================================================
// COMPONENT
// ============================================================================
const GuestChatBox = ({ branchId, branchEmail, branchName, guestId, onClose }) => {
  // ============================================================================
  // STATE
  // ============================================================================
  const [localBranchId, setLocalBranchId] = useState(branchId || "");
  const [guestDetails, setGuestDetails] = useState({ name: "", phone: "", email: "" });
  const [isDetailsSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [media, setMedia] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [isOptimizingImage, setIsOptimizingImage] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [branchStatus, setBranchStatus] = useState({ online: false, lastSeen: "Unknown" });
  const [typingIndicator, setTypingIndicator] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPrivacyNoticeMinimized, setIsPrivacyNoticeMinimized] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  // Idle auto-close happened: session data erased, show the security notice.
  const [idleClosed, setIdleClosed] = useState(false);
  const isClosingRef = useRef(false);
  const [isConnected, setIsConnected] = useState(true);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [transcriptSuccessMsg, setTranscriptSuccessMsg] = useState("");
  // UAT F-G4: in-app close confirmation (replaces window.confirm).
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const [networkType, setNetworkType] = useState(
    navigator.connection?.effectiveType || "unknown"
  );
  const [isInputExpanded, setIsInputExpanded] = useState(false);

  // Sensitive data detection state
  const [sensitiveWarning, setSensitiveWarning] = useState(null);
  const [showSensitiveTopicBanner, setShowSensitiveTopicBanner] = useState(false);
  const [pendingReviewMessage, setPendingReviewMessage] = useState(null);
  const [detectedPatterns, setDetectedPatterns] = useState([]);
  const [hasConfirmedSensitive, setHasConfirmedSensitive] = useState(false);
  const [isFirstMessage, setIsFirstMessage] = useState(true);

  // E2EE state
  const [e2eeStatus, setE2eeStatus] = useState("initializing"); // initializing | exchanging | established | failed
  const [e2eeError, setE2eeError] = useState(null);

  // ============================================================================
  // REFS
  // ============================================================================
  const inputFileRef = useRef(null);
  const offlineTimer = useRef(null);
  // Always points to the latest handleChatClose so the unmount-only effect can
  // run the full close flow (archive + chatClosed) without a stale closure.
  const handleChatCloseRef = useRef(null);

  // ============================================================================
  // COMPUTED VALUES
  // ============================================================================
  const isSlow = networkType.includes("2g");

  // Debounced branch status updates
  const debouncedSetBranchStatus = useRef(
    debounce((status) => {
      setBranchStatus({
        online: !!status.online,
        lastSeen: status.lastSeen ? formatLastSeen(status.lastSeen) : "Unknown",
      });
    }, STATUS_DEBOUNCE_MS)
  ).current;

  // ============================================================================
  // NETWORK EFFECTS
  // ============================================================================
  useEffect(() => {
    const connection = navigator.connection;
    if (!connection) return;

    const update = () => {
      console.log(`[NETWORK] connection changed → ${connection.effectiveType}`);
      setNetworkType(connection.effectiveType);
    };

    connection.addEventListener("change", update);
    return () => connection.removeEventListener("change", update);
  }, []);

  // ============================================================================
  // FULL CLOSE ON NAVIGATION AWAY / UNMOUNT
  // ----------------------------------------------------------------------------
  // If the guest leaves the page (route change, idle auto-close, etc.) WITHOUT
  // using the X button, the component unmounts while `chatOpen` is still set, so
  // the history-effect cleanup skipped teardown and the conversation lingered on
  // the admin side (no `chatClosed` ever sent). Here we run the same close flow
  // as the X button on a true unmount, unless an explicit close already handled
  // it (isClosingRef). Empty deps + a ref keep this from firing on dependency
  // changes (e.g. localBranchId hydration) — only on actual unmount.
  // ============================================================================
  useEffect(() => {
    return () => {
      if (isClosingRef.current) return; // explicit X-close already archived + emitted
      const closeFn = handleChatCloseRef.current;
      if (typeof closeFn === "function") closeFn();
    };
  }, []);

  // ============================================================================
  // SECURITY: AUTO-ERASE CACHE ON WINDOW CLOSE (Internet Café Protection)
  // ============================================================================
  useEffect(() => {
    const clearSensitiveCache = () => {
      // Clear all guest chat related session data
      const keysToClear = [
        'guestId',
        'branchEmail',
        'guestToken',
        'chatOpen',
        'pendingMessages',
        'draftMessage',
        'chatHistory'
      ];
      
      keysToClear.forEach(key => {
        sessionStorage.removeItem(key);
        localStorage.removeItem(key);
      });
      
      // Clear any branch-specific message caches
      const allKeys = Object.keys(sessionStorage);
      allKeys.forEach(key => {
        if (key.startsWith('msgs_') || key.includes('chat') || key.includes('guest')) {
          sessionStorage.removeItem(key);
        }
      });
      
      console.log('[SECURITY] Cache auto-erased on window close');
    };

    // Handle browser close/refresh
    window.addEventListener('beforeunload', clearSensitiveCache);
    
    // Handle tab visibility change (for mobile app switching)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Set a flag that the tab was hidden
        sessionStorage.setItem('tabHiddenAt', Date.now().toString());
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      window.removeEventListener('beforeunload', clearSensitiveCache);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // ============================================================================
  // SECURITY: IDLE TIMEOUT AUTO-ERASE (Walk-away Protection)
  // ============================================================================
  // On timeout: archive the conversation (chatClosed → branch side stays
  // consistent), erase every trace from this device, then show an in-frame
  // notice EXPLAINING the close instead of silently vanishing — guests kept
  // thinking the chat "broke". The notice renders only after the wipe, so
  // nothing sensitive remains behind it.
  useEffect(() => {
    if (idleClosed) return; // chat already closed — nothing left to guard
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of inactivity
    let idleTimer;

    const clearAllData = async () => {
      console.log('[SECURITY] Idle timeout - auto-erasing all guest data');

      // 1) Archive + notify the branch first (needs the token/ids, so it must
      //    run BEFORE the wipe). keepMounted: the widget stays on screen to
      //    show the security notice instead of unmounting.
      try {
        await handleChatCloseRef.current?.({ keepMounted: true });
      } catch (err) {
        console.warn('[SECURITY] ⚠️ Idle-close archive failed:', err?.message);
      }

      // 2) Clear all storage
      const keysToClear = [
        'guestId', 'branchEmail', 'guestToken', 'chatOpen',
        'pendingMessages', 'draftMessage', 'chatHistory'
      ];
      keysToClear.forEach(key => {
        sessionStorage.removeItem(key);
        localStorage.removeItem(key);
      });

      // Clear message caches
      Object.keys(sessionStorage).forEach(key => {
        if (key.startsWith('msgs_') || key.includes('chat') || key.includes('guest')) {
          sessionStorage.removeItem(key);
        }
      });

      // Clear state (guestId is a prop, not state - parent controls it)
      setMessages([]);

      // 3) Swap the chat UI for the inactivity notice (dismiss → onClose)
      setIdleClosed(true);
    };
    
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(clearAllData, IDLE_TIMEOUT_MS);
    };
    
    // Reset timer on user activity
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(event => {
      window.addEventListener(event, resetIdleTimer, true);
    });
    
    // Start initial timer
    resetIdleTimer();
    
    return () => {
      clearTimeout(idleTimer);
      events.forEach(event => {
        window.removeEventListener(event, resetIdleTimer, true);
      });
    };
  }, [guestId, onClose, idleClosed]);

  // ============================================================================
  // SECURITY: E2EE VIA SERVER-MANAGED CONVERSATION KEY
  // ----------------------------------------------------------------------------
  // We fetch the per-conversation AES-256 key from the backend (the SAME key the
  // branch admin fetches) and import it as the AES-GCM shared key. This replaces
  // the ephemeral ECDH handshake, so the channel is established immediately and
  // does not depend on the branch being online. The fetched key feeds the
  // existing e2eeEncrypt/e2eeDecrypt paths unchanged.
  // ============================================================================
  useEffect(() => {
    if (!guestId || !branchEmail) return;
    if (isE2EEEstablished(guestId)) {
      setE2eeStatus("established");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setE2eeStatus("initializing");
        const token =
          sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken");
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/messages/conversation-key`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          }
        );
        if (!res.ok) throw new Error(`conversation-key fetch failed (${res.status})`);
        const { key } = await res.json();
        if (!key) throw new Error("no conversation key returned");
        if (cancelled) return;
        await establishWithServerKey(guestId, key);
        setE2eeError(null);
        setE2eeStatus("established");
        console.log("[E2EE] Conversation key established");
      } catch (error) {
        if (cancelled) return;
        console.error("[E2EE] Conversation key fetch failed:", error.message);
        setE2eeStatus("failed");
        setE2eeError(error.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [guestId, branchEmail]);

  // ============================================================================
  // WAKE HANDLING EFFECT
  // ============================================================================
  useEffect(() => {
    const handleWake = async () => {
      const gid = localStorage.getItem("guestId") || sessionStorage.getItem("guestId");
      const bEmail = sessionStorage.getItem("branchEmail");
      if (document.visibilityState !== "visible") return;

      if (!socket?.connected) {
        if (gid && bEmail) {
          console.info("[GUEST] 💤 Wake detected — reconnecting socket for", gid);
          await connectSocket(gid);
        } else {
          console.warn("[GUEST] ❌ Wake triggered but no valid session — cannot reconnect", {
            gid,
            bEmail,
          });
        }
      } else {
        console.debug("[GUEST] 💤 Wake detected — already connected.");
      }
    };

    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("focus", handleWake);
    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("focus", handleWake);
    };
  }, []);

  // ============================================================================
  // RETRY SEND MESSAGE
  // ============================================================================
  // Retry send (stable id + per-branch cache writes)
  const retrySendMessage = useCallback(
    async (retryMessage, retryMedia = null, existingClientMessageId = null) => {
      const isEvent = retryMessage && typeof retryMessage === "object" && retryMessage.nativeEvent;
      const contentToRetry = !isEvent && typeof retryMessage === "string" ? retryMessage : "";
      const mediaToRetry = !isEvent ? (retryMedia !== null ? retryMedia : media || previewFile) : null;

      if (!contentToRetry.trim() && !mediaToRetry) {
        console.warn("[RETRY] ⚠️ Cannot retry an empty message.");
        return;
      }
      if (!isConnected) {
        console.warn("[RETRY] ⚠️ Cannot retry while offline.");
        return;
      }

      // E2EE parity with the live send path: a retry must not silently
      // downgrade an established secure channel to plaintext (UAT F-G6).
      let encryptedPayload = null;
      let encryptionMetadata = null;
      if (isE2EEEstablished(guestId) && contentToRetry) {
        try {
          encryptedPayload = await e2eeEncrypt(guestId, contentToRetry);
          encryptionMetadata = {
            e2ee: true,
            algorithm: "AES-256-GCM",
            keyExchange: "ECDH-P-256",
          };
        } catch (e2eeError) {
          console.error("[E2EE] Retry encryption failed, sending plaintext:", e2eeError.message);
        }
      }

      const tempId = generateTempId();
      const clientMessageId = existingClientMessageId || generateClientMessageId();

      const optimistic = {
        guestId,
        branchId: localBranchId,
        branchEmail,
        sender: "guest",
        content: contentToRetry,
        message: contentToRetry,
        media: mediaToRetry,
        timestamp: new Date().toISOString(),
        pending: true,
        status: "sent",
        tempId,
        clientMessageId,
      };
      // Replace the stale failed bubble (same clientMessageId) instead of
      // appending a duplicate — otherwise every retry leaves a dead "failed"
      // copy with its own Retry button behind the fresh attempt (UAT F-G7).
      setMessages((prev) => [
        ...prev.filter((m) => !(m.clientMessageId === clientMessageId && m.status === "failed")),
        optimistic,
      ]);

      try {
        const token = sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken");
        const url = `${process.env.REACT_APP_API_URL}/api/messages/send`;

        const opts = {
          method: "POST",
          credentials: "include",
          headers: {},
          body: null,
        };

        if (mediaToRetry) {
          const formData = new FormData();
          formData.append("branchId", localBranchId);
          formData.append("branchEmail", branchEmail);
          formData.append("guestId", guestId);
          formData.append("content", encryptedPayload ? JSON.stringify(encryptedPayload) : contentToRetry);
          formData.append("media", mediaToRetry);
          formData.append("clientMessageId", clientMessageId);
          if (encryptedPayload) {
            formData.append("e2ee", "true");
            formData.append("encryptionMeta", JSON.stringify(encryptionMetadata));
          }
          opts.body = formData;
          if (token) opts.headers.Authorization = `Bearer ${token}`;
        } else {
          opts.headers["Content-Type"] = "application/json";
          if (token) opts.headers.Authorization = `Bearer ${token}`;
          opts.body = JSON.stringify({
            branchId: localBranchId,
            branchEmail,
            guestId,
            content: encryptedPayload ? JSON.stringify(encryptedPayload) : contentToRetry,
            clientMessageId,
            e2ee: !!encryptedPayload,
            encryptionMeta: encryptionMetadata,
          });
        }

        const response = await fetchWithBackoff(url, opts);
        const data = await response.json();

        if (response.ok && data.savedMessage) {
          const saved = data.savedMessage;
          const confirmed = {
            ...saved,
            id: saved.id || clientMessageId,
            clientMessageId,
            guestId,
            branchId: localBranchId,
            branchEmail,
            sender: "guest",
            status: "sent",
            pending: false,
            archived: false,
            // Show local plaintext — when E2EE is on the server echoes ciphertext.
            message: encryptedPayload ? contentToRetry : (saved.content || contentToRetry),
            content: encryptedPayload ? contentToRetry : (saved.content || contentToRetry),
            e2ee: !!encryptedPayload,
            tempId,
          };

          setMessages((prev) => {
            const u = [...prev];
            const idx = u.findIndex((m) => m.tempId === tempId);
            if (idx !== -1) u[idx] = confirmed;
            else u.push(confirmed);
            sessionStorage.setItem(getCacheKey(guestId, localBranchId), JSON.stringify(u));
            return u;
          });

          // WS emit
          sendMessage({
            room: `guest-${guestId.replace(/^guest-/, "")}`,
            guestId,
            branchEmail,
            // Emit ciphertext when E2EE is on — same rule as the live send path.
            content: encryptedPayload ? JSON.stringify(encryptedPayload) : confirmed.content,
            media: confirmed.media || null,
            sender: "guest",
            id: confirmed.id,
            clientMessageId,
            e2ee: !!encryptedPayload,
            timestamp: confirmed.timestamp,
          })
            .then((ack) => {
              console.log("[RETRY] 📡 WS ack:", ack);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === confirmed.id ? { ...m, status: "delivered", pending: false } : m
                )
              );
            })
            .catch((err) => {
              // UAT F-G2: persisted via REST + broadcast by the backend — only
              // the delivery tick is missing. See the live-send path.
              console.warn("[RETRY] ⚠️ Delivery ack failed (message persisted):", err);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === confirmed.id
                    ? { ...m, status: "unconfirmed", pending: false }
                    : m
                )
              );
            });
        } else {
          console.error("[RETRY] ❌ API failed:", data);
          setMessages((prev) => {
            const u = [...prev];
            const idx = u.findIndex((m) => m.tempId === tempId);
            if (idx !== -1) {
              u[idx] = {
                ...u[idx],
                status: "failed",
                pending: true,
                failureReason: data.error || "Retry failed",
                retry: () => retrySendMessage(contentToRetry, mediaToRetry, clientMessageId),
                clientMessageId,
              };
            }
            sessionStorage.setItem(getCacheKey(guestId, localBranchId), JSON.stringify(u));
            return u;
          });
        }
      } catch (err) {
        console.error("[RETRY] ❌ Unexpected error:", err);
        setMessages((prev) => {
          const u = [...prev];
          const idx = u.findIndex((m) => m.tempId === tempId);
          if (idx !== -1) {
            u[idx] = {
              ...u[idx],
              status: "failed",
              pending: true,
              failureReason: err.message || "Unexpected error",
              retry: () => retrySendMessage(contentToRetry, mediaToRetry, clientMessageId),
              clientMessageId,
            };
          }
          sessionStorage.setItem(getCacheKey(guestId, localBranchId), JSON.stringify(u));
          return u;
        });
      }
    },
    [branchEmail, guestId, localBranchId, isConnected, media, previewFile]
  );

  // ============================================================================
  // CONNECTION STATUS EFFECT
  // ============================================================================
  // Connection status → retry failed items
  useEffect(() => {
    const handleConnectionChange = (connected) => {
      setIsConnected(connected);
      console.log("[CHATBOX] ⚡ Connection status changed:", connected);

      if (connected) {
        setMessages((prev) => {
          const failedMessages = prev.filter((msg) => msg.status === "failed");
          failedMessages.forEach((msg) => {
            console.log("[RETRY] ⏳ Retrying failed message:", msg.content);
            retrySendMessage(msg.content, msg.media || null, msg.clientMessageId || null);
          });
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

  // ============================================================================
  // OFFLINE BANNER EFFECT
  // ============================================================================
  // Debounced offline banner
  useEffect(() => {
    if (isConnected) {
      if (offlineTimer.current) {
        clearTimeout(offlineTimer.current);
        offlineTimer.current = null;
      }
      setShowOffline(false);
    } else {
      offlineTimer.current = setTimeout(() => {
        setShowOffline(true);
      }, 5000);
    }
    return () => {
      if (offlineTimer.current) clearTimeout(offlineTimer.current);
    };
  }, [isConnected]);

  // ============================================================================
  // CHAT HISTORY & SOCKET HANDLERS EFFECT
  // ============================================================================
  // History load (per-branch cache) + socket handlers
  useEffect(() => {
    const fetchChatHistory = async () => {
      try {
        setIsLoading(true);

        // 1) Per-branch cache
        const cacheKey = getCacheKey(guestId, localBranchId);
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
          try {
            const arr = JSON.parse(cached);
            if (Array.isArray(arr) && arr.length) {
              const pruned = arr.filter((m) => m.branchId === localBranchId);
              if (pruned.length) {
                console.log("[CHAT] 💾 Loaded from session cache (per-branch)");
                setMessages(pruned);
              }
            }
          } catch (err) {
            console.warn("[CHAT] ⚠️ Couldn’t parse cache:", err.message);
          }
        }

        // 2) Server history
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/messages/history/${guestId}`,
          { credentials: "include" }
        );
        const body = await res.json();

        if (res.ok) {
          const normalized = body.messages
            .filter((m) => m.branchId === localBranchId)
            .map((m) => ({
              ...m,
              timestamp: m.timestamp
                ? new Date(m.timestamp).toISOString()
                : new Date().toISOString(),
            }));

          if (normalized.length) {
            setMessages(normalized);
            sessionStorage.setItem(cacheKey, JSON.stringify(normalized));
            console.log("[CHAT] ✅ History loaded & cached (per-branch)");
          } else {
            console.warn("[CHAT] ⚠️ No messages from API");
            sessionStorage.removeItem(cacheKey);
          }

          normalized
            .filter((m) => m.sender === "branch" && m.status === "sent")
            .forEach((m) => emitMessageSeen(guestId, m.id));
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

    if (!branchEmail || !guestId) {
      console.error("[GUEST] ❌ Missing branchEmail or guestId");
      setError("Unable to connect to chat. Please try again later.");
      return;
    }

    setBranchStatus({ online: false, lastSeen: "Unknown" });

    if (isDetailsSubmitted) {
      fetchChatHistory();
    }

    // Socket message handler
    const handleIncomingMessage = async (msg) => {
      // 🔒 HARD FILTER: only accept messages for the active branch
      if (msg.branchId && msg.branchId !== localBranchId) return;
      if (msg.branchEmail &&
      msg.branchEmail.toLowerCase() !== (branchEmail || "").toLowerCase()) return;

      if (!msg.timestamp) msg.timestamp = new Date().toISOString();
      else if (msg.timestamp.toDate) msg.timestamp = msg.timestamp.toDate().toISOString();
      if (msg.guestId !== guestId) return;

      // ============================================================================
      // E2EE: Decrypt message content if encrypted
      // ============================================================================
      let decryptedContent = msg.content || msg.message || "";
      let decryptedMessage = msg.message || msg.content || "";
      
      if (msg.e2ee && msg.content && isE2EEEstablished(guestId)) {
        try {
          // Parse encrypted payload
          const encryptedPayload = JSON.parse(msg.content);
          if (encryptedPayload.ciphertext && encryptedPayload.iv) {
            decryptedContent = await e2eeDecrypt(guestId, encryptedPayload.ciphertext, encryptedPayload.iv);
            decryptedMessage = decryptedContent;
            console.log("[E2EE] Message decrypted successfully");
          }
        } catch (decryptError) {
          console.error("[E2EE] Decryption failed:", decryptError.message);
          // Keep original content if decryption fails
          decryptedContent = "[Encrypted - Unable to decrypt]";
          decryptedMessage = decryptedContent;
        }
      }

      const normalized = {
        ...msg,
        pending: false,
        message: decryptedMessage,
        content: decryptedContent,
        encrypted: msg.e2ee || false,
      };

      setMessages((prev) => {
        const next = [...prev];

        if (normalized.clientMessageId) {
          const i = next.findIndex(
            (m) => m.pending && m.clientMessageId === normalized.clientMessageId
          );
          if (i !== -1) {
            next[i] = { ...next[i], ...normalized, pending: false };
          } else if (!next.find((m) => m.id === normalized.id)) {
            next.push(normalized);
          }
        } else {
          const idx = next.findIndex(
            (m) => m.pending && m.message === normalized.message && m.sender === "guest"
          );
          if (idx !== -1) next[idx] = normalized;
          else if (!next.find((m) => m.id === normalized.id)) next.push(normalized);
        }

        sessionStorage.setItem(getCacheKey(guestId, localBranchId), JSON.stringify(next));
        return next;
      });

      if (normalized.sender === "branch" && document.visibilityState === "visible") {
        emitMessageSeen(guestId, normalized.id);
      }
    };

    onNewMessage(handleIncomingMessage);

    socket.on("connect", () => {
      console.log("[GUEST] 🔁 Reattached onNewMessage after reconnect");
      onNewMessage(handleIncomingMessage);
    });

    return () => {
      console.log("[GUEST] 🧹 Cleaning up GuestChatBox...");
      // Only disconnect here if handleChatClose didn't already initiate it
      if (!isClosingRef.current && !sessionStorage.getItem("chatOpen")) {
        disconnectSocket(true, "manual");
      }
      offNewMessage(handleIncomingMessage);
      if (socket.off) {
        socket.off("receiveMessage");
        socket.off("connect");
        socket.__messageListenerAttached = false;
      }
    };
  }, [branchEmail, guestId, isDetailsSubmitted, localBranchId]);

  // ============================================================================
  // BRANCH STATUS FETCH EFFECT
  // ============================================================================
  // Fetch current branch status once
  useEffect(() => {
    if (!branchEmail) return;
    (async () => {
      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/branch-status?branchEmail=${encodeURIComponent(
            branchEmail
          )}`,
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

  // ============================================================================
  // BRANCH STATUS LISTENER EFFECT
  // ============================================================================
  // Listen for branch status updates
  useEffect(() => {
    if (!branchEmail) return;

    const handleBranchStatus = (status) => {
      if (status.branchEmail && branchEmail &&
          status.branchEmail.toLowerCase() === branchEmail.toLowerCase()) {
        console.debug("[GUEST] Socket branchStatus (debounced):", status);
        debouncedSetBranchStatus(status);
      }
    };

    onBranchStatus(handleBranchStatus);
    return () => {
      offBranchStatus(handleBranchStatus);
      debouncedSetBranchStatus.cancel?.();
    };
  }, [branchEmail, debouncedSetBranchStatus]);

  // ============================================================================
  // GUEST ROOM JOIN EFFECT
  // ============================================================================
  // Join guest room on connect
  useEffect(() => {
    if (guestId && isConnected) {
      const guestRoom = `guest-${guestId.replace(/^guest-/, "")}`;
      socket.emit("joinRoom", guestRoom, () => {
        console.log("[GUEST] Joined guest room:", guestRoom);
      });
    }
  }, [guestId, isConnected]);

  // ============================================================================
  // MESSAGE HANDLING FUNCTIONS
  // ============================================================================
  // Mark last pending message as failed + cache write
  const updateLastPendingMessageAsFailed = (failureReason) => {
    setMessages((prev) => {
      const updated = [...prev];
      const pendingFlags = updated.map((m) => !!m.pending);
      const idx = pendingFlags.lastIndexOf(true);
      if (idx !== -1) {
        updated[idx] = {
          ...updated[idx],
          status: "failed",
          pending: true,
          failureReason,
          retry: () =>
            retrySendMessage(
              updated[idx].message || updated[idx].content,
              updated[idx].media || null,
              updated[idx].clientMessageId || null
            ),
        };
      }
      sessionStorage.setItem(getCacheKey(guestId, localBranchId), JSON.stringify(updated));
      return updated;
    });
    setError("");
  };

  // ============================================================================
  // SEND MESSAGE FUNCTION
  // ============================================================================
  // Send message (idempotent with clientMessageId)
  const handleSendMessage = async (overrideMedia = null, overrideContent = null) => {
    if (!isConnected) {
      console.warn("[GUEST] ⚠️ Cannot send while offline");
      updateLastPendingMessageAsFailed("Cannot send while offline");
      return setIsLoading(false);
    }

    try {
      await ensureValidGuestToken();
    } catch (err) {
      console.warn("[GUEST] ⚠️ Proactive token refresh failed:", err.message);
    }

    const isEvent = overrideMedia && typeof overrideMedia === "object" && overrideMedia.nativeEvent;
    const mediaToSend =
      !isEvent && overrideMedia !== null ? overrideMedia : media || previewFile;
    const contentToSend = overrideContent !== null ? overrideContent : message.trim();

    // Guard: avoid empty sends (UI already disables the button, but double-check)
    if (!mediaToSend && contentToSend.length === 0) {
      return;
    }

    // Pre-flight review: only prompt when the message actually contains
    // suspected sensitive information (not merely because it's the first message).
    const patterns = detectSensitivePatterns(contentToSend);
    if (patterns.length > 0 && !hasConfirmedSensitive && !pendingReviewMessage) {
      setPendingReviewMessage(contentToSend);
      setDetectedPatterns(patterns);
      return; // Stop here, wait for user confirmation
    }

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

    const tempId = generateTempId();
    const clientMessageId = generateClientMessageId();

    // ============================================================================
    // E2EE: Encrypt message content if secure channel is established
    // ============================================================================
    let encryptedPayload = null;
    let encryptionMetadata = null;
    
    if (isE2EEEstablished(effectiveGuestId) && contentToSend) {
      try {
        encryptedPayload = await e2eeEncrypt(effectiveGuestId, contentToSend);
        encryptionMetadata = {
          e2ee: true,
          algorithm: "AES-256-GCM",
          keyExchange: "ECDH-P-256",
        };
        console.log("[E2EE] Message encrypted before sending");
      } catch (e2eeError) {
        console.error("[E2EE] Encryption failed, sending plaintext:", e2eeError.message);
        // Continue with plaintext if encryption fails (fail-open for UX, but logged)
      }
    }

    const optimisticMessage = {
      guestId: effectiveGuestId,
      branchId: localBranchId,
      branchEmail,
      sender: "guest",
      content: contentToSend, // Store plaintext locally for optimistic UI
      message: contentToSend,
      timestamp: new Date().toISOString(),
      archived: false,
      pending: true,
      status: "sent",
      tempId,
      clientMessageId,
      media: mediaToSend || null,
      encrypted: !!encryptedPayload, // Track if this was sent encrypted
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    const token = sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken");
    const url = `${process.env.REACT_APP_API_URL}/api/messages/send`;
    let opts = {
      method: "POST",
      credentials: "include",
      headers: {},
      body: null,
    };

    if (mediaToSend) {
      const form = new FormData();
      form.append("branchId", localBranchId);
      form.append("branchEmail", branchEmail);
      form.append("guestId", effectiveGuestId);
      // Send encrypted payload if available, otherwise plaintext
      form.append("content", encryptedPayload ? JSON.stringify(encryptedPayload) : contentToSend);
      form.append("media", mediaToSend);
      form.append("clientMessageId", clientMessageId);
      if (encryptedPayload) {
        form.append("e2ee", "true");
        form.append("encryptionMeta", JSON.stringify(encryptionMetadata));
      }
      opts.body = form;
      if (token) opts.headers.Authorization = `Bearer ${token}`;
    } else {
      opts.headers["Content-Type"] = "application/json";
      if (token) opts.headers.Authorization = `Bearer ${token}`;
      opts.body = JSON.stringify({
        branchId: localBranchId,
        branchEmail,
        guestId: effectiveGuestId,
        // Send encrypted payload if available, otherwise plaintext
        content: encryptedPayload ? JSON.stringify(encryptedPayload) : contentToSend,
        clientMessageId,
        e2ee: !!encryptedPayload,
        encryptionMeta: encryptionMetadata,
      });
    }

    try {
      let response = await fetchWithBackoff(url, opts);

      if (response.status === 401) {
        console.warn("[GUEST] ⚠️ Token expired, refreshing token and retrying...");
        if (!window.__CSRF_TOKEN__) await fetchCsrfToken();
        const refreshRes = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/refresh-token`, {
          method: "POST",
          credentials: "include",
          headers: {
            "X-CSRF-Token": window.__CSRF_TOKEN__,
            // P1-4: prior token as proof (in case the cross-site cookie is blocked).
            "Authorization": `Bearer ${sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken") || ""}`,
          },
        });
        // UAT: persist the refreshed token — previously the response was
        // discarded and the retry silently reused the stale header token
        // (it only worked because the refreshed cookie rode along).
        try {
          const refreshData = await refreshRes.json();
          if (refreshData && refreshData.token) {
            sessionStorage.setItem("guestToken", refreshData.token);
            localStorage.setItem("guestToken", refreshData.token);
          }
        } catch (_) { /* non-JSON response — fall back to stored token */ }
        const newToken = sessionStorage.getItem("guestToken");
        if (!newToken) throw new Error("Unable to refresh guest token");
        opts.headers.Authorization = `Bearer ${newToken}`;
        response = await fetchWithBackoff(url, opts);
      }

      const data = await response.json();
      if (!response.ok || !data.savedMessage) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const saved = data.savedMessage;
      const confirmedMessage = {
        ...saved,
        id: saved.id || clientMessageId,
        clientMessageId,
        guestId: effectiveGuestId,
        branchId: localBranchId,
        branchEmail,
        sender: "guest",
        status: "sent",
        pending: false,
        archived: false,
        // Display the local plaintext for our own message. When E2EE is on,
        // the server echoes back the ciphertext, which must never be shown raw.
        content: encryptedPayload ? contentToSend : (saved.content || contentToSend),
        message: encryptedPayload ? contentToSend : (saved.content || contentToSend),
        e2ee: !!encryptedPayload,
        tempId,
        media: saved.media || mediaToSend || null,
      };

      setMessages((prev) => {
        const arr = [...prev];
        const idx = arr.findIndex((m) => m.tempId === tempId);
        if (idx > -1) arr[idx] = confirmedMessage;
        else arr.push(confirmedMessage);
        sessionStorage.setItem(getCacheKey(guestId, localBranchId), JSON.stringify(arr));
        return arr;
      });

      // Clear draft only on success
      setMessage("");
      setMedia(null);
      setPreviewFile(null);
      if (inputFileRef.current) {
        inputFileRef.current.value = "";
      }

      // Reset sensitive data detection states
      setIsFirstMessage(false);
      setHasConfirmedSensitive(false);
      setSensitiveWarning(null);
      setShowSensitiveTopicBanner(false);

      const guestRoom = `guest-${effectiveGuestId.replace(/^guest-/, "")}`;
      sendMessage({
        room: guestRoom,
        guestId: effectiveGuestId,
        branchEmail,
        // Emit ciphertext over the wire so the admin side can decrypt; never
        // broadcast plaintext when an E2EE channel is established.
        content: encryptedPayload ? JSON.stringify(encryptedPayload) : confirmedMessage.content,
        media: confirmedMessage.media,
        sender: "guest",
        id: confirmedMessage.id,
        clientMessageId,
        e2ee: !!encryptedPayload,
        timestamp: confirmedMessage.timestamp,
      })
        .then((ack) => {
          console.log("[SOCKET] 📡 WS ack for guest message:", ack);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === confirmedMessage.id ? { ...msg, status: "delivered", pending: false } : msg
            )
          );
          sessionStorage.setItem(
            getCacheKey(guestId, localBranchId),
            JSON.stringify(
              (function (arr) {
                return arr.map((m) =>
                  m.id === confirmedMessage.id ? { ...m, status: "delivered", pending: false } : m
                );
              })(JSON.parse(sessionStorage.getItem(getCacheKey(guestId, localBranchId)) || "[]"))
            )
          );
        })
        .catch((err) => {
          // UAT F-G2: the message IS saved — the REST call succeeded and the
          // backend broadcasts it to the branch room on save. Only the
          // delivery-tick ack failed, so mark it "unconfirmed" instead of
          // scaring the guest into resending with a false "Failed to send".
          console.warn("[SOCKET] ⚠️ Delivery ack failed (message persisted):", err);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === confirmedMessage.id
                ? { ...msg, status: "unconfirmed", pending: false }
                : msg
            )
          );
        });

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

  // Close chat box. keepMounted (idle auto-close): run the FULL close flow —
  // archive, chatClosed emit, socket teardown — but skip onClose() so the
  // widget can keep rendering the inactivity notice instead of unmounting.
  const handleChatClose = async ({ keepMounted = false } = {}) => {
    // Mark closing synchronously (before any await) so the other unmount
    // cleanups reliably see it and skip their own teardown.
    isClosingRef.current = true;

    try {
      await ensureValidGuestToken();
    } catch (err) {
      console.warn("[CLIENT:GUEST] ⚠️ Proactive token refresh failed:", err.message);
    }

    try {
      console.log("[CLIENT:GUEST] 🚪 Closing chat for guestId:", guestId);
      setIsClosing(true);

      if (!guestId || !branchEmail) {
        console.error("[CLIENT:GUEST] ❌ Cannot close chat. guestId or branchEmail missing.");
        return;
      }

      const token =
        sessionStorage.getItem("guestToken") ||
        localStorage.getItem("guestToken") ||
        window.__FALLBACK_GUEST_TOKEN__;
      if (!token) {
        console.warn("[CLIENT:GUEST] ❌ Missing guest token for REST fallback");
      }
      const canonId = guestId.toLowerCase().startsWith("guest-")
        ? guestId.toLowerCase()
        : `guest-${guestId.toLowerCase()}`;

      const payload = { guestId: canonId, branchEmail };
      const doRestFallback = async () => {
        try {
          const res = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/force-close`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (res.ok) {
            console.log("[CLIENT:GUEST] ✅ Fallback REST emit successful:", data);
          } else if (data.error === "No messages found.") {
            console.info(
              "[CLIENT:GUEST] ℹ️ No prior messages to archive; chat close acknowledged."
            );
          } else {
            console.error("[CLIENT:GUEST] ❌ Fallback REST emit failed:", data.error);
          }
        } catch (err) {
          console.error("[CLIENT:GUEST] ❌ REST fallback error:", err.message);
        }
      };

      if (document.visibilityState === "hidden") {
        console.warn("[CLIENT:GUEST] 📴 Tab hidden — using immediate REST fallback");
        await doRestFallback();
      } else {
        if (socket && socket.connected) {
          socket.emit("chatClosed", payload);
          console.log("[CLIENT:GUEST] 📤 Sent chatClosed via socket");
          // Socket succeeded — no REST fallback needed
        } else if (socket && !socket.connected && token) {
          console.warn("[CLIENT:GUEST] ⏳ Reconnecting socket to emit chatClosed...");
          socket.auth = { token, guestId: canonId, branchEmail };
          socket.once("connect", () => {
            console.log("[CLIENT:GUEST] 🔁 Reconnected — emitting chatClosed");
            socket.emit("chatClosed", payload);
          });
          try {
            socket.connect();
          } catch (err) {
            console.error("[CLIENT:GUEST] ❌ Reconnect failed — falling back to REST");
            await doRestFallback();
          }
          // Safety net: if socket never reconnects within 3s, use REST
          setTimeout(async () => {
            if (!socket.connected) await doRestFallback();
          }, 3000);
        } else {
          console.warn("[CLIENT:GUEST] ⚠️ Socket unavailable — using REST fallback");
          await doRestFallback();
        }
      }
    } catch (err) {
      console.error("[CLIENT:GUEST] ❌ Error during handleChatClose:", err.message);
    } finally {
      // The chat is over: drop the open-flag so the Branches page can't
      // auto-resurrect a conversation the guest explicitly ended (UAT F-G9).
      // Keep guestId/guestToken — session reuse for a NEW chat is intended.
      sessionStorage.removeItem("chatOpen");
      disconnectSocket(false, "manual");
      if (!keepMounted) onClose();
    }
  };

  // Keep the unmount-only effect pointed at the latest close handler so a
  // navigation/idle unmount runs the full close (archive + chatClosed).
  handleChatCloseRef.current = handleChatClose;

  // User-initiated close (X button): play the slide-out exit animation first,
  // THEN run the real teardown + unmount so the chat box closes smoothly
  // instead of vanishing abruptly. Non-user paths (idle/navigation) still close
  // directly via handleChatClose.
  const CLOSE_ANIM_MS = 280; // keep in sync with .guest-chat-box--closing
  const handleUserClose = () => {
    if (isClosingRef.current) return; // already closing — ignore repeat clicks
    isClosingRef.current = true;       // skip the unmount-effect re-teardown
    setIsClosing(true);                // triggers the slide-out animation
    window.setTimeout(() => {
      handleChatClose();
    }, CLOSE_ANIM_MS);
  };

  // Sensitive data confirmation handlers
  const confirmSensitiveSend = () => {
    setHasConfirmedSensitive(true);
    setSensitiveWarning(null);
    const contentToSend = pendingReviewMessage;
    setPendingReviewMessage(null);
    // Proceed with sending
    handleSendMessage(null, contentToSend);
  };

  const cancelSensitiveSend = () => {
    setPendingReviewMessage(null);
    setDetectedPatterns([]);
    setHasConfirmedSensitive(false);
  };

  const editSensitiveMessage = () => {
    // Keep the message in input for editing
    setMessage(pendingReviewMessage || message);
    setPendingReviewMessage(null);
    setHasConfirmedSensitive(false);
  };

  // Typing handlers with sensitive data detection
  const handleLocalTyping = (e) => {
    const text = e.target.value;
    setMessage(text);
    emitTyping(guestId, guestId, text.length > 0);

    // Check for sensitive topic keywords
    const isSensitive = isSensitiveTopic(text);
    setShowSensitiveTopicBanner(isSensitive);

    // Detect specific patterns for warnings
    const patterns = detectSensitivePatterns(text);
    if (patterns.length > 0 && !hasConfirmedSensitive) {
      setSensitiveWarning(patterns);
    } else if (patterns.length === 0) {
      setSensitiveWarning(null);
    }
  };

  const handleInputFocus = () => {
    setIsInputExpanded(true);
  };

  const handleInputBlur = () => {
    setIsInputExpanded(false);
  };

  useEffect(() => {
    const handleIncomingTyping = ({ sender, isTyping }) => {
      if (sender !== branchEmail) return;
      setTypingIndicator(isTyping ? "Staff is typing..." : null);
    };
    onTyping(handleIncomingTyping);
    return () => offTyping(handleIncomingTyping);
  }, [branchEmail]);

  // Handle messageSeen WebSocket event - when admin marks guest message as seen
  useEffect(() => {
    const handleMessageSeen = (message) => {
      const messageId = message.id || message.messageId;
      console.log("[GUEST] 📩 Received messageSeen event:", message);
      console.log("[GUEST] Message ID:", messageId, "seenByAdmin:", message.seenByAdmin);
      console.log("[GUEST] Current messages count:", messages.length);
      setMessages(prev => {
        const updated = prev.map(msg => {
          const isMatch = msg.id === messageId;
          if (isMatch) {
            console.log("[GUEST] Found matching message:", msg.id, "setting seenByAdmin to true");
            return { ...msg, seenByAdmin: true };
          }
          return msg;
        });
        const updatedCount = updated.filter(m => m.id === messageId && m.seenByAdmin).length;
        console.log("[GUEST] Updated messages count with seenByAdmin true:", updatedCount);
        return updated;
      });
    };
    
    // Handle markRead event - when admin selects guest's conversation
    const handleMarkRead = (data) => {
      const guestIdFromEvent = data.guestId;
      console.log("[GUEST] 📩 Received markRead event:", data);
      console.log("[GUEST] Guest ID:", guestId, "Data guest ID:", guestIdFromEvent);
      
      // Check if this markRead is for this guest
      if (guestIdFromEvent === guestId || guestIdFromEvent === `guest-${guestId.replace(/^guest-/, "")}`) {
        console.log("[GUEST] markRead is for this guest, marking all guest messages as seen");
        setMessages(prev => {
          const updated = prev.map(msg => {
            if (msg.sender === "guest") {
              return { ...msg, seenByAdmin: true };
            }
            return msg;
          });
          return updated;
        });
      }
    };
    
    const socket = getSocketInstance();
    console.log("[GUEST] Setting up messageSeen listener on socket:", socket?.connected);
    
    // Log all socket events for debugging
    const logAllEvents = (event, data) => {
      console.log("[GUEST] 📡 Socket event received:", event, data);
    };
    
    if (socket) {
      socket.on('messageSeen', handleMessageSeen);
      socket.on('markRead', handleMarkRead);
      socket.onAny(logAllEvents);
      console.log("[GUEST] ✅ Listening for messageSeen, markRead and all socket events");
    }
    
    return () => {
      if (socket) {
        socket.off('messageSeen', handleMessageSeen);
        socket.off('markRead', handleMarkRead);
        socket.offAny(logAllEvents);
        console.log("[GUEST] 🧹 Cleaned up messageSeen, markRead and logAllEvents listeners");
      }
    };
  }, [guestId, messages]);

  // Mark admin messages as seen when guest views them
  useEffect(() => {
    const markAdminMessagesAsSeen = async () => {
      const token = sessionStorage.getItem("guestToken");
      if (!token || messages.length === 0) return;

      // Find admin messages that haven't been seen by guest
      const unseenAdminMessages = messages.filter(
        msg => msg.sender === "branch" && !msg.seenByGuest
      );

      if (unseenAdminMessages.length === 0) return;

      // Update local state immediately for better UX
      const unseenIds = new Set(unseenAdminMessages.map(msg => msg.id));
      setMessages(prev => prev.map(msg => 
        unseenIds.has(msg.id) ? { ...msg, seenByGuest: true } : msg
      ));

      // Then call API to persist
      for (const msg of unseenAdminMessages) {
        try {
          await fetch(`${process.env.REACT_APP_API_URL}/api/messages/mark-seen-by-guest/${msg.id}`, {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          });
          console.log("[GUEST] ✅ Marked admin message as seen:", msg.id);
        } catch (err) {
          console.error("[GUEST] ❌ Failed to mark admin message as seen:", err.message);
          // Revert local state on failure
          setMessages(prev => prev.map(m => 
            m.id === msg.id ? { ...m, seenByGuest: false } : m
          ));
        }
      }
    };

    markAdminMessagesAsSeen();
  }, [messages]);

   // If props change (branch switch), clear UI quickly; history loader will refill.
    useEffect(() => {
      setMessages([]);
      setMessage("");
      setMedia(null);
      setPreviewFile(null);
    }, [localBranchId, branchEmail, guestId]);

  // Force-close on unload (unchanged)
  useEffect(() => {
    const onBeforeUnloadChatClose = () => {
      const gid = sessionStorage.getItem("guestId");
      const bEmail = sessionStorage.getItem("branchEmail");
      const token = sessionStorage.getItem("guestToken");

      if (!gid || !bEmail) {
        console.warn("[GUEST] ❌ Missing guestId or branchEmail — skipping unload handler.");
        return;
      }

      try {
        const url = `${process.env.REACT_APP_API_URL}/api/guest/force-close`;
        // P3-4: send the auth token in the JSON body (not a ?token= query param,
        // which leaks into logs/history/referrers). sendBeacon can't set headers;
        // the backend reads the token from the body for this header-less call.
        const payload = JSON.stringify({ guestId: gid, branchEmail: bEmail, token });
        navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
        console.log("[GUEST] 📡 Beacon sent to force-close API.");
      } catch (err) {
        console.warn("[GUEST] ❌ Beacon failed:", err.message);
      }

      const waitUntil = performance.now() + 50;
      while (performance.now() < waitUntil);
    };

    window.addEventListener("beforeunload", onBeforeUnloadChatClose);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnloadChatClose);
    };
  }, []);

  // Disable send (offline, busy, or empty text & no image)
  const isSendDisabled =
    showOffline || !branchStatus.online || isLoading || isOptimizingImage || (message.trim().length === 0 && !previewFile);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  // Idle auto-close notice: takes precedence over every other view (even
  // minimized — a minimized chat that got erased must still explain itself).
  // All session data is already wiped; dismissing simply unmounts the widget
  // so the page's chat button is available for a fresh conversation.
  if (idleClosed) {
    return (
      <div className="guest-chat-box">
        <GuestIdleNotice minutes={5} onDismiss={onClose} />
      </div>
    );
  }

  return (
    <>
      {/* Minimized Chat Widget */}
      {isMinimized ? (
        <div className="chat-widget" onClick={() => setIsMinimized(false)}>
          <span className={`status-dot ${branchStatus.online ? "online" : "offline"}`} />
          <span>Chat with {branchName || "Support"}</span>
        </div>
      ) : (
        <div className={`guest-chat-box${isClosing ? " guest-chat-box--closing" : ""}`}>
          {/* Header */}
          <div className="guest-chat-box-header gc--yellow">
            <div className="gc-left">
              <div className="gc-avatar" aria-hidden="true" title={branchName || "Support"}>
                {(branchName || "Support").trim().charAt(0).toUpperCase()}
              </div>

              <div className="gc-titles">
                <div className="gc-title">{branchName || "Support"}</div>

                <div className="gc-subtitle">
                  {showOffline ? (
                    <span className="gc-status-off text-gray-500 text-sm">Unavailable</span>
                  ) : branchStatus.online ? (
                    <span className="gc-status-on text-green-500 font-bold">Active Now</span>
                  ) : (
                    <span className="gc-status-off text-gray-500 text-sm">Offline</span>
                  )}
                </div>
              </div>
            </div>

            {/* Right controls */}
            <div className="gc-right">
              {!showOffline && (
                <span
                  className="gc-net"
                  onClick={() => setShowNetworkModal(true)}
                  title="Network info"
                  role="button"
                >
                  {networkType.toUpperCase()}
                </span>
              )}
              <button
                type="button"
                className="gc-icon-btn"
                onClick={() => setIsMinimized(true)}
                aria-label="Minimize"
                title="Minimize"
              >
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path fill="currentColor" d="M7 10l5 5 5-5H7z" />
                </svg>
              </button>
              <button
                type="button"
                className="gc-icon-btn gc-icon-danger"
                onClick={() => {
                  // UAT F-G4: in-app confirm instead of window.confirm.
                  if (messages.length === 0) handleUserClose();
                  else setShowCloseConfirm(true);
                }}
                aria-label="Close"
                title="Close"
              >
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path
                    fill="currentColor"
                    d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7A1 1 0 1 0 5.7 7.1L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Success message after download/send */}
          {transcriptSuccessMsg && (
            <div className="bg-green-100 text-green-700 text-sm px-4 py-2 border border-green-300 rounded mx-4 my-2">
              {transcriptSuccessMsg}
            </div>
          )}

          {/* Offline Banner (debounced) */}
          {showOffline && (
            <div className="bg-red-100 text-red-700 text-center py-2 px-4 border-b border-red-300">
              ⚠️ You are currently offline. Trying to reconnect...
            </div>
          )}

          {/* Sensitive Topic Banner */}
          {showSensitiveTopicBanner && (
            <div className="bg-yellow-50 text-yellow-700 text-xs px-3 py-2 border-b border-yellow-200 flex items-start gap-2">
              <span>💡</span>
              <span>
                <strong>Format Detected:</strong> Your message appears to contain sensitive information patterns. 
                For your security, please avoid sharing card numbers, PINs, passwords, or ID details in chat. 
                Our staff only needs your ticket number for verification.
              </span>
            </div>
          )}

          {/* E2EE Security Status */}
          {e2eeStatus === "established" ? (
            <div className="bg-green-50 text-green-700 text-[10px] px-3 py-1 border-b border-green-200 flex items-center justify-center gap-1">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z"/>
              </svg>
              <span title="AES-256-GCM · encrypted in transit &amp; at rest">Your messages are encrypted</span>
            </div>
          ) : e2eeStatus === "failed" ? (
            <div className="bg-green-50 text-green-700 text-[10px] px-3 py-1 border-b border-green-200 flex items-center justify-center gap-1">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z"/>
              </svg>
              <span>Secure connection</span>
            </div>
          ) : (
            <div className="bg-blue-50 text-blue-700 text-[10px] px-3 py-1 border-b border-blue-200 flex items-center justify-center gap-1">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
              <span>Establishing secure channel...</span>
            </div>
          )}

          {/* Chat Content */}
          <div className="guest-chat-box-content">
            {error && (
              <p className="error-message text-red-500 font-semibold text-sm mb-2">{error}</p>
            )}

            {/* Welcome State - Only show when no messages */}
            {messages.length === 0 && (
              <div className="greeting-card">
                <h3 className="greeting-title">Magis Live Chat</h3>
                <p className="greeting-text">
                  Magtanong tungkol sa sangla, tubos, renewal, schedule ng subasta, o branch hours.
                </p>
                <p className="greeting-text" style={{ marginTop: '8px' }}>
                  Nandito kami para masagot agad ang tanong mo bago ka pumunta sa branch.
                </p>
                <div className="trust-badge">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                  <span>Verified Support</span>
                </div>
              </div>
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
                  key={msg.id || msg.clientMessageId || msg.tempId || idx}
                  className={`message-wrapper mb-4 ${msg.sender}`}
                >
                  <MessageItem 
                    message={msg} 
                    sender={msg.sender} 
                    hideMedia={false} 
                    isLatest={idx === messages.length - 1}
                  />

                  <div
                    className="message-timestamp mt-1"
                    style={{
                      alignSelf: msg.sender === "guest" ? "flex-end" : "flex-start",
                    }}
                  >
                    {formattedTime}
                  </div>

                  {/* Retry button for failed messages */}
                  {msg.status === "failed" && (
                    <button
                      className="retry-btn text-blue-500 underline text-sm mt-1"
                      onClick={() =>
                        retrySendMessage(
                          msg.content,
                          msg.media || null,
                          msg.clientMessageId || null
                        )
                      }
                    >
                      Retry
                    </button>
                  )}
                </div>
              );
            })}

            {isLoading && (
              <p className="sending-message-label italic text-xs mt-1">Sending message...</p>
            )}

            {typingIndicator && (
              <p className="typing-indicator text-sm text-gray-500 mb-2">{typingIndicator}</p>
            )}

            {/* Sensitive Pattern Warning Toast */}
            {sensitiveWarning && sensitiveWarning.length > 0 && (
              <div className="bg-orange-50 text-orange-700 text-xs px-3 py-2 rounded-lg mb-2 border border-orange-200 flex items-start gap-2">
                <span>⚠️</span>
                <div>
                  <p className="font-medium">Format Detected:</p>
                  <p className="text-orange-600 mt-1">
                    Your message contains patterns that resemble sensitive information. 
                    For your security, please avoid sharing these details. Staff will only ask for necessary information to assist you.
                  </p>
                </div>
                <button
                  onClick={() => setSensitiveWarning(null)}
                  className="ml-auto text-orange-500 hover:text-orange-700"
                >
                  ×
                </button>
              </div>
            )}

            {/* Pre-flight Review Modal */}
            {pendingReviewMessage && (
              <div className="bg-white border border-yellow-300 rounded-lg p-3 mb-2 shadow-sm">
                <div className="flex items-start gap-2 mb-2">
                  <span className="text-yellow-500">🔒</span>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-800">Magis Pawnshop Security Review</p>
                    {detectedPatterns.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        Detected: {detectedPatterns.map(p => `${p.icon} ${p.name}`).join(', ')}
                      </p>
                    )}
                    <p className="text-xs text-yellow-600 mt-1">
                      Staff only need your ticket number to help with sangla, tubos, or renewal inquiries.
                    </p>
                  </div>
                </div>
                <div className="bg-gray-50 rounded p-2 mb-3 text-sm text-gray-700 max-h-20 overflow-y-auto">
                  {maskSensitiveData(pendingReviewMessage)}
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={editSensitiveMessage}
                    className="px-3 py-1 text-xs text-gray-600 hover:text-gray-800 border rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={cancelSensitiveSend}
                    className="px-3 py-1 text-xs text-red-600 hover:text-red-800 border border-red-200 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmSensitiveSend}
                    className="px-3 py-1 text-xs text-white bg-yellow-500 hover:bg-yellow-600 rounded"
                  >
                    Confirm & Send
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer: Image preview + toolbar */}
          <div className="guest-chat-box-footer bg-white border-t px-4 py-3">
            {/* Preview Thumbnail */}
            {isOptimizingImage && (
              <div className="flex justify-center mb-3 text-xs italic text-gray-500">
                Optimizing image…
              </div>
            )}
            {previewFile && (
              <div role="alert" className="upload-id-warning">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="upload-id-warning__icon"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>
                  Please do not upload photos of IDs, bank cards, or documents showing
                  personal or financial details. For verification, kindly bring them to
                  the branch in person.
                </span>
              </div>
            )}
            {previewFile && (
              <div className="attach-preview">
                <div className="attach-preview__box">
                  <img
                    src={URL.createObjectURL(previewFile)}
                    alt="Attachment preview"
                    className="attach-preview__img"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewFile(null);
                      inputFileRef.current.value = "";
                    }}
                    className="attach-preview__remove"
                    aria-label="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              </div>
            )}

            {/* Zero-Click Privacy Consent Notice - Minimizable */}
            <div className="bg-gray-50 text-gray-400 text-[9px] px-2 py-1 border-t border-gray-200 text-center leading-tight">
              {isPrivacyNoticeMinimized ? (
                <button
                  type="button"
                  onClick={() => setIsPrivacyNoticeMinimized(false)}
                  className="cursor-pointer underline hover:text-gray-600 transition-colors bg-transparent border-0 p-0 text-inherit"
                  aria-label="Show privacy notice"
                >
                  Privacy Policy
                </button>
              ) : (
                <div className="flex items-center justify-between gap-1">
                  <span className="flex-1">
                    For your safety, avoid sharing passwords, card numbers, or IDs in chat. See our{' '}
                    <a 
                      href="/privacy-policy" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="underline hover:text-gray-600"
                    >
                      privacy policy
                    </a>
                    .
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsPrivacyNoticeMinimized(true)}
                    className="cursor-pointer hover:text-gray-600 ml-1 bg-transparent border-0 p-0 text-inherit"
                    title="Hide"
                    aria-label="Hide privacy notice"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* Main toolbar - Full-width input layout */}
            {/* Row 1: Full-width message input */}
            <div className="footer-input-row">
              {/* Message input */}
              <input
                type="text"
                value={message}
                onChange={handleLocalTyping}
                onFocus={handleInputFocus}
                onBlur={handleInputBlur}
                onKeyDown={(e) => {
                  // UAT F-G14: Enter sends (the universal chat idiom). Same
                  // guard as the Send button; Shift+Enter reserved.
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  if (isSendDisabled) return;
                  emitTyping(guestId, guestId, false);
                  handleSendMessage();
                }}
                disabled={showOffline || !branchStatus.online}
                placeholder={showOffline || !branchStatus.online 
                  ? "Branch is currently offline" 
                  : showSensitiveTopicBanner 
                    ? "⚠️ Never share passwords, PINs, or full card numbers" 
                    : previewFile 
                      ? "Enter caption for this image" 
                      : "Chat branch"}
                className={`h-10 px-3 border rounded-lg focus:outline-none ${isInputExpanded ? 'input-expanded' : ''}`}
              />
            </div>

            {/* Row 2: Secondary actions */}
            <div className="footer-actions-row">
              <div className="footer-actions-left">
                {/* Attach image */}
                <label
                  className={`flex-shrink-0 p-2 rounded ${showOffline || !branchStatus.online ? "opacity-30 cursor-not-allowed" : "hover:bg-gray-100 cursor-pointer"}`}
                  title="Attach image"
                  onClick={showOffline || !branchStatus.online ? (e) => e.preventDefault() : undefined}
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
                    disabled={showOffline || !branchStatus.online}
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      // PERF4-6: downscale + recompress on the client before
                      // upload (keeps JPEG/PNG — no backend/security change).
                      setIsOptimizingImage(true);
                      try {
                        const optimized = await optimizeImage(file, {
                          maxWidth: 1600,
                          maxHeight: 1600,
                          quality: 0.82,
                        });
                        setPreviewFile(optimized);
                      } catch (err) {
                        console.warn(
                          "[GUEST] image optimize failed; sending original:",
                          err?.message
                        );
                        setPreviewFile(file);
                      } finally {
                        setIsOptimizingImage(false);
                      }
                    }}
                  />
                </label>

                {/* Message the branch via the email-style form (UAT F-G5: the
                    old tooltip promised a transcript download that the modal
                    never offered) */}
                <button
                  type="button"
                  onClick={() => setShowTranscriptModal(true)}
                  title="Contact branch"
                  aria-label="Contact branch"
                  className="email-icon p-2 rounded focus:outline-none hover:bg-gray-100"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-6 h-6"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    stroke="none"
                  >
                    <path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 2l-8 5-8-5h16zm0 12H4V8l8 5 8-5v10z" />
                  </svg>
                </button>
              </div>

              {/* Send button on right */}
              <div className="footer-actions-right">
                <button
                  onClick={() => {
                    if (isSendDisabled) return;
                    emitTyping(guestId, guestId, false);
                    handleSendMessage();
                  }}
                  disabled={isSendDisabled}
                  aria-disabled={isSendDisabled}
                  title={
                    isSendDisabled
                      ? showOffline
                        ? "You're offline"
                        : "Type a message or attach an image"
                      : "Send"
                  }
                  type="button"
                  className={`px-4 py-2 rounded text-white ${
                    isSendDisabled ? "bg-gray-300 cursor-not-allowed" : "bg-blue-500 hover:bg-blue-600"
                  }`}
                >
                  Send
                </button>
              </div>
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
          <div className="bg-white rounded-lg p-6 max-w-sm text-center" onClick={(e) => e.stopPropagation()}>
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

      {/* UAT F-G4: in-app close confirmation (replaces window.confirm) */}
      <GuestConfirmDialog
        open={showCloseConfirm}
        title="End this chat?"
        body="Closing will end the conversation — starting again requires a new chat."
        confirmLabel="End chat"
        cancelLabel="Keep chatting"
        onConfirm={() => {
          setShowCloseConfirm(false);
          handleUserClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </>
  );
};

export default GuestChatBox;
