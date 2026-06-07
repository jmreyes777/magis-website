import React, { createContext, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { jwtDecode } from "jwt-decode";
import { disconnectSocket } from "../components/Admin-Utils-socket";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { getSessionIds } from "../utils/initSession";
import { ensureSessionHydrated } from "../utils/sessionHydration";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const navigate = useNavigate();
  const auth = getAuth();

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [adminEmail, setAdminEmail] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [fallbackHydrationComplete, setFallbackHydrationComplete] = useState(false);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [firebaseAuthReady, setFirebaseAuthReady] = useState(false);
  
  // MFA State
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [mfaVerified, setMfaVerified] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(true);

  const logoutTriggeredRef = useRef(false);

  useEffect(() => {
  // 🚨 Cold-start cleanup: if there’s no JWT in sessionStorage,
  // clear any stale socket-ownership or fallback values.
  const hasSuper   = !!sessionStorage.getItem("superAdminToken");
  const hasBranch  = !!sessionStorage.getItem("branchAdminToken");
  if (!hasSuper && !hasBranch) {
    console.info("[AUTH] 🔄 Cold start detected—clearing stale socket & fallback data");
    localStorage.removeItem("activeSocketTabId");
    localStorage.removeItem("fallbackBranchEmail");
    localStorage.removeItem("fallbackBranchRole");
    localStorage.removeItem("fallbackBranchId");
    localStorage.removeItem("fallbackBranchName");
  }

  const { sessionTabId, tabId } = getSessionIds();

  const hydrate = async () => {
    const token =
      sessionStorage.getItem("superAdminToken") ||
      sessionStorage.getItem("branchAdminToken");

    const role =
      token === sessionStorage.getItem("superAdminToken")
        ? "superadmin"
        : "branchadmin";

    try {
      if (token) {
        const decoded = jwtDecode(token);
      
        if (decoded.exp * 1000 > Date.now()) {
          // ── valid token on initial load ───────────────────────
          setIsAuthenticated(true);
          setUserRole(role);
          setAdminEmail(decoded.email);
          setSessionHydrated(true);
          setFallbackHydrationComplete(true);
          console.info("[AUTH] ✅ Initial token hydrate complete");
        } else if (role === "branchadmin") {
          // attempt to refresh fallback token
          try {
            const branchEmail = sessionStorage.getItem("branchEmail");
            // Prove prior auth so the backend will rotate the token (P0-1):
            // a fresh Firebase ID token when available, plus the just-expired
            // HMAC token as a rotation proof.
            const fbToken = auth.currentUser
              ? await auth.currentUser.getIdToken().catch(() => null)
              : null;
            const res = await fetch(
              `${process.env.REACT_APP_API_URL}/api/issue-fallback-token`,
              {
                method: "POST",
                credentials: "include",
                headers: {
                  "Content-Type": "application/json",
                  ...(fbToken ? { Authorization: `Bearer ${fbToken}` } : {}),
                },
                body: JSON.stringify({ branchEmail, currentToken: token }),
              }
            );
            const data = await res.json();
            if (res.ok && data.token) {
              sessionStorage.setItem("branchAdminToken", data.token);
              console.info("[AUTH] 🔄 Fallback token re-issued");
              const newDecoded = jwtDecode(data.token);
              setIsAuthenticated(true);
              setUserRole(role);
              setAdminEmail(newDecoded.email);
              setSessionHydrated(true);
              return; // stop here, don’t logout
            }
          } catch (err) {
            console.error("[AUTH] ❌ Failed to refresh fallback token:", err);
          }
          console.warn("[AUTH] ❌ Token expired and refresh failed — logging out.");
          triggerLogout();
        } else {
          console.warn("[AUTH] ❌ Token expired — logging out.");
          triggerLogout();
        }
      } else {
        // ── no token: attempt fallback hydration ─────────────────
        const fallbackRole  = localStorage.getItem("fallbackBranchRole");
        const fallbackEmail = localStorage.getItem("fallbackBranchEmail");
        const fallbackId    = localStorage.getItem("fallbackBranchId");
        const fallbackName  = localStorage.getItem("fallbackBranchName");
        const activeTabId   = localStorage.getItem("activeSocketTabId");

        if (fallbackEmail && fallbackRole && activeTabId === tabId) {
          console.info("[AUTH] 🧩 Rehydrating fallback session (tab owner)");

          // ensure sessionTabId exists
          if (!sessionTabId) {
            console.warn("[AUTH] ⌛ Waiting for sessionTabId before restoring session...");
            for (let i = 0; i < 10; i++) {
              await new Promise((res) => setTimeout(res, 100));
              if (window.name) break;
            }
          }

          // fetch a fresh fallback token
          if (!sessionStorage.getItem("branchAdminToken")) {
            try {
              // Prove prior auth (P0-1): prefer a fresh Firebase ID token; the
              // HTTP-only branchAdminToken cookie (sent via credentials) also
              // serves as a rotation proof when still within the grace window.
              const fbToken = auth.currentUser
                ? await auth.currentUser.getIdToken().catch(() => null)
                : null;
              const response = await fetch(
                `${process.env.REACT_APP_API_URL}/api/issue-fallback-token`,
                {
                  method: "POST",
                  credentials: "include",
                  headers: {
                    "Content-Type": "application/json",
                    ...(fbToken ? { Authorization: `Bearer ${fbToken}` } : {}),
                  },
                  body: JSON.stringify({ branchEmail: fallbackEmail }),
                }
              );
              const data = await response.json();
              if (!data.token) throw new Error("No fallback token");
              sessionStorage.setItem("branchAdminToken", data.token);
              sessionStorage.setItem("branchEmail",      fallbackEmail);
              sessionStorage.setItem("branchAdminRole",  fallbackRole);
              if (fallbackId)   sessionStorage.setItem("branchId",   fallbackId);
              if (fallbackName) sessionStorage.setItem("branchName", fallbackName);

              window.__LAST_HYDRATED_TOKEN__ = data.token;
              window.__LAST_HYDRATED_EMAIL__ = fallbackEmail;
            } catch (error) {
              console.error("[AUTH] ❌ Failed to fetch fallback token:", error.message);
              triggerLogout();
              setFallbackHydrationComplete(true);
              setIsInitialized(true);
              return;
            }
          }

          localStorage.setItem("hasAuthenticatedOnce", "true");
          const hydrated = await ensureSessionHydrated();
          if (!hydrated?.token || !hydrated?.email) {
            console.error("[AUTH] ❌ Hydration failed — aborting fallback login");
            setFallbackHydrationComplete(true);
            triggerLogout();
            return;
          }

          console.info("[AUTH] ✅ Session fully hydrated — continuing login");
          setIsAuthenticated(true);
          setUserRole(fallbackRole);
          setAdminEmail(fallbackEmail);
          setSessionHydrated(true);
          setFallbackHydrationComplete(true);
        } else {
          // public route whitelist
          if (window.location.pathname !== "/") {
            console.warn("[AUTH] ❌ No valid token or fallback — logging out.");
            if (activeTabId === tabId) {
              console.info("[AUTH] 🧼 Clearing stale activeSocketTabId.");
              localStorage.removeItem("activeSocketTabId");
            }
            triggerLogout();
          }
          setFallbackHydrationComplete(true);
        }
      }
    } catch (err) {
      console.error("[AUTH] ❌ Decode error:", err.message);
      triggerLogout();
      setFallbackHydrationComplete(true);
    } finally {
      setIsInitialized(true);
    }
  };

  hydrate();

  // ── Listen for post-login events to re-run hydrate() ─────────────
  const handleAuth = (event) => {
    console.info(`[AUTH] 🔄 Received ${event.type} event — re-hydrating session`);
    hydrate();
  };
  window.addEventListener("branchAdminAuthenticated", handleAuth);
  window.addEventListener("superAdminAuthenticated", handleAuth);

  onAuthStateChanged(auth, (user) => {
    setFirebaseAuthReady(!!user);
  });

  const bc = new BroadcastChannel("admin-socket");
  const onUnload = () => bc.postMessage({ type: "tab-closing", tabId });
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("pagehide",      onUnload);

  return () => {
    window.removeEventListener("beforeunload", onUnload);
    window.removeEventListener("pagehide",      onUnload);
    window.removeEventListener("branchAdminAuthenticated", handleAuth);
    window.removeEventListener("superAdminAuthenticated", handleAuth);
    bc.close();
  };
}, []);
 

  const triggerLogout = async (isTabClosing = false) => {
    if (logoutTriggeredRef.current) return;
    logoutTriggeredRef.current = true;
    await handleLogout(isTabClosing);
  };

  // ============================================================================
  // MFA FUNCTIONS
  // ============================================================================
  
  /**
   * Check MFA enrollment status
   */
  const checkMFAStatus = async () => {
    try {
      const token = sessionStorage.getItem('branchAdminToken') || 
                   localStorage.getItem('branchAdminToken');
      
      if (!token) return false;
      
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/status`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      
      if (!res.ok) {
        console.warn('[MFA] Failed to check status:', res.status);
        return false;
      }
      
      const data = await res.json();
      setMfaEnrolled(data.enrolled);
      setMfaRequired(data.required);
      
      // Check if MFA was previously verified in this session
      const mfaVerifiedInSession = sessionStorage.getItem('mfaVerified') === 'true';
      setMfaVerified(mfaVerifiedInSession);
      
      return data.enrolled;
    } catch (error) {
      console.error('[MFA] Error checking status:', error);
      return false;
    }
  };
  
  /**
   * Complete MFA verification
   */
  const completeMFAVerification = () => {
    setMfaVerified(true);
    sessionStorage.setItem('mfaVerified', 'true');
    localStorage.setItem('mfaVerified', 'true');
  };
  
  /**
   * Clear MFA verification (e.g., on logout or session timeout)
   */
  const clearMFAVerification = () => {
    setMfaVerified(false);
    sessionStorage.removeItem('mfaVerified');
    localStorage.removeItem('mfaVerified');
  };

  const handleLogout = async (isTabClosing = false) => {
    const tabId = localStorage.getItem("tabId");
    const email = adminEmail || sessionStorage.getItem("branchEmail");
    const activeTabId = localStorage.getItem("activeSocketTabId");
  
    // 1️⃣ Update online status in Firestore if this tab owns the socket
    if (email && activeTabId === tabId) {
      try {
        const payload = {
          branchEmail: email,
          email,
          online: false,
          lastSeen: new Date().toISOString(),
        };
        const url = `${process.env.REACT_APP_API_URL}/api/update-status`;
  
        if (isTabClosing && navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(payload)], {
            type: "application/json",
          });
          navigator.sendBeacon(url, blob);
          console.info("[AUTH] 🔔 Sent offline status via sendBeacon");
        } else {
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          console.info("[AUTH] 🔔 Sent offline status via fetch");
        }
  
        await disconnectSocket(email);
      } catch (error) {
        console.error("[AUTH] Error during logout status update:", error);
      }
    } else {
      console.log("[AUTH] Skipping Firestore update — not socket owner.");
    }
  
    // 2️⃣ Immediately mark disconnected
    window.__SOCKET_CONNECTED = false;
  
    // 3️⃣ Revoke server‐side JWT in Redis (via HttpOnly cookie)
    try {
      const base = process.env.REACT_APP_API_URL || "";
      if (userRole === "superadmin") {
        await fetch(`${base}/api/superadmin/logout`, {
          method: "POST",
          credentials: "include",
        });
        console.info("[AUTH] 🔐 Super-Admin logged out server-side");
      } else if (userRole === "branchadmin") {
        await fetch(`${base}/api/branchadmin/logout`, {
          method: "POST",
          credentials: "include",
        });
        console.info("[AUTH] 🔐 Branch-Admin logged out server-side");
      }
    } catch (err) {
      console.error("[AUTH] Error calling logout endpoint:", err);
    }
  
    // 4️⃣ Wipe all stored tokens/sessions
    sessionStorage.clear();
    localStorage.removeItem("activeSocketTabId");
    localStorage.removeItem("branchAdminToken");
    localStorage.removeItem("branchAdminRole");
    localStorage.removeItem("superAdminToken");
    localStorage.removeItem("superAdminRole");
    localStorage.removeItem("mfaVerified");

    // ── nuke any leftover fallback-login info ──
    localStorage.removeItem("fallbackBranchEmail");
    localStorage.removeItem("fallbackBranchRole");
    localStorage.removeItem("fallbackBranchId");
    localStorage.removeItem("fallbackBranchName");
    // ── clear any saved chats for this branch ──
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("branchChats-")) {
        localStorage.removeItem(key);
      }
    });
  
    // 5️⃣ Tell the Service Worker to drop its copy of the token
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "CLEAR_AUTH_TOKEN",
      });
    }
  
    // 6️⃣ Finalize UI logout
    setTimeout(() => {
      setIsAuthenticated(false);
      setUserRole(null);
      setAdminEmail(null);
    }, 50);
  
    // 7️⃣ Redirect to the appropriate login page
    if (!isTabClosing) {
      const target =
        userRole === "superadmin"
          ? "/super-admin-login"
          : "/branch-admin-login";
      navigate(target, { replace: true });
    }
  };  

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        setIsAuthenticated,
        userRole,
        setUserRole,
        adminEmail,
        setAdminEmail,
        isInitialized,
        fallbackHydrationComplete,
        sessionHydrated,
        firebaseAuthReady,
        handleLogout,
        // MFA State
        mfaEnrolled,
        mfaVerified,
        mfaRequired,
        checkMFAStatus,
        completeMFAVerification,
        clearMFAVerification,
        branchSession: {
          id: sessionStorage.getItem("branchId"),
          email: sessionStorage.getItem("branchEmail"),
          name: sessionStorage.getItem("branchName"),
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;