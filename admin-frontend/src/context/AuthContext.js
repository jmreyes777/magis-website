import React, { createContext, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { jwtDecode } from "jwt-decode";
import { disconnectSocket } from "../components/Admin-Utils-socket";
import { getAuth, onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
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
  // Logout UX: true while an intentional logout is in flight. Drives the
  // "Logging out…" overlay below and lets ConnectionStatus suppress the amber
  // "Reconnecting to chat…" banner (the socket teardown during logout is not a
  // connection problem the staffer should be warned about).
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const logoutTriggeredRef = useRef(false);
  const fbSessionAttemptRef = useRef(false);

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
          // Public route whitelist. UAT F11: this used to be "/" alone, so a
          // signed-out DIRECT load of /super-admin-login or /staff-login hit
          // triggerLogout() → forced redirect to /branch-admin-login — the
          // superadmin literally couldn't reach their own login page by URL.
          const PUBLIC_PATHS = [
            "/",
            "/branch-admin-login",
            "/super-admin-login",
            "/staff-login",
          ];
          if (!PUBLIC_PATHS.includes(window.location.pathname)) {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Ensure a Firebase Auth session for branch-admin dashboards.
  //
  // The OTP login mints an HMAC token (edge worker + Socket.IO), but the chat
  // dashboard reads chats/messages and writes presence via the Firebase client
  // SDK, whose security rules require request.auth. On a page reload / reopened
  // tab the HMAC session is restored from storage while Firebase's
  // browserSessionPersistence may already be gone — leaving Firestore
  // permission-denied. Here we re-establish the Firebase session from a
  // backend-minted custom token whenever it's missing, so Firestore is
  // authorized on EVERY load (not only right after login). Never blocks the HMAC
  // session.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (firebaseAuthReady) return; // already signed into Firebase
    if (!isAuthenticated || userRole !== "branchadmin") return;
    if (fbSessionAttemptRef.current) return;

    let cancelled = false;
    const establish = async () => {
      // Give Firebase a brief moment to restore an existing session from storage
      // before minting a new one (avoids redundant requests on reload).
      await new Promise((r) => setTimeout(r, 700));
      if (cancelled || auth.currentUser) return;

      const token =
        sessionStorage.getItem("branchAdminToken") ||
        localStorage.getItem("branchAdminToken");
      if (!token) return;

      fbSessionAttemptRef.current = true;
      try {
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/branch/firebase-token`,
          {
            method: "POST",
            credentials: "include",
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.firebaseToken && !auth.currentUser) {
          await signInWithCustomToken(auth, data.firebaseToken);
          console.info("[AUTH] ✅ Firebase session re-established for dashboard Firestore");
        } else if (!res.ok) {
          console.warn("[AUTH] Firebase token endpoint failed:", res.status, data.error);
        }
      } catch (e) {
        console.warn("[AUTH] Could not establish Firebase session:", e.message);
      } finally {
        fbSessionAttemptRef.current = false;
      }
    };
    establish();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, userRole, firebaseAuthReady, auth]);

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
    // Buttons wire this as onClick={handleLogout}, which passes the click
    // EVENT as the first argument — truthy, so every button logout silently
    // took the tab-closing path (skipping its own redirect and the overlay).
    // Only an explicit `true` means the tab is actually closing.
    isTabClosing = isTabClosing === true;
    // Show the logout overlay immediately (not when the tab is closing — there
    // is no UI left to cover in that case).
    if (!isTabClosing) setIsLoggingOut(true);
    const tabId = localStorage.getItem("tabId");
    const email = adminEmail || sessionStorage.getItem("branchEmail");
    const activeTabId = localStorage.getItem("activeSocketTabId");
    // P3-4: capture the admin token UP-FRONT, before disconnectSocket() clears
    // sessionStorage, so both the offline beacon (step 1) and the logout-revoke
    // call (step 3) can authenticate via the JSON body. The SameSite=Strict
    // cookie isn't sent cross-site to the edge worker, so the body token is the
    // only credential the backend can use to revoke the jti. Reading it here
    // (not a ?token= query param) keeps it out of logs/history/referrers.
    const adminToken =
      sessionStorage.getItem("branchAdminToken") ||
      localStorage.getItem("branchAdminToken") ||
      "";
  
    // 1️⃣ Update online status in Firestore if this tab owns the socket
    if (email && activeTabId === tabId) {
      try {
        const payload = {
          branchEmail: email,
          email,
          online: false,
          lastSeen: new Date().toISOString(),
          token: adminToken,
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
        // P3-4: send the token in the JSON body too (credentials:"include" still
        // carries the cookie same-origin). Cross-site to the edge worker the
        // SameSite=Strict cookie isn't sent, so the body token is what lets the
        // backend revoke the jti. Mirrors /api/update-status.
        await fetch(`${base}/api/branchadmin/logout`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: adminToken }),
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
    // Keep the overlay through the navigation paint, then release it.
    setTimeout(() => setIsLoggingOut(false), 600);
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
        isLoggingOut,
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
      {isLoggingOut && (
        <div
          role="status"
          aria-live="assertive"
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-700/70"
        >
          <div className="bg-white rounded-xl shadow-2xl px-6 py-4 flex items-center gap-3">
            <span
              className="h-5 w-5 rounded-full border-2 border-gray-300 border-t-gray-700 animate-spin"
              aria-hidden="true"
            />
            <span className="text-gray-800 font-semibold">Logging out…</span>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
};

export default AuthContext;