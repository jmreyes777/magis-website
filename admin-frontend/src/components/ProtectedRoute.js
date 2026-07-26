import React, { useContext } from "react";
import { Navigate } from "react-router-dom";
import AuthContext from "../context/AuthContext";

/**
 * ProtectedRoute Component
 * Ensures only authenticated users with the correct role can access a route.
 * Supports multi-tab WebSocket awareness using tabId + activeSocketTabId + session fallback.
 */
const ProtectedRoute = ({ children, requiredRole = null, redirectPath = "/" }) => {
  const {
    isAuthenticated,
    userRole,
    isInitialized,
    fallbackHydrationComplete,
    sessionHydrated,
    isLoggingOut,
  } = useContext(AuthContext);

  const tabId = localStorage.getItem("tabId");
  const activeSocketTabId = localStorage.getItem("activeSocketTabId");

  const superAdminToken  = sessionStorage.getItem("superAdminToken");
  const branchAdminToken = sessionStorage.getItem("branchAdminToken");
  const token            = superAdminToken || branchAdminToken;

  const role =
    superAdminToken  ? "superadmin" :
    branchAdminToken ? "branchadmin" :
    null;

  // Detect if the branch token is the fallback placeholder
  const isFallbackToken = branchAdminToken === "__FALLBACK_FAKE_TOKEN__";

  // ⏳ Wait for AuthContext to finish initializing & hydrating
  if (!isInitialized || !fallbackHydrationComplete || !sessionHydrated) {
    return null;
  }

  // 🚪 Intentional logout in flight: handleLogout wipes storage BEFORE its
  // navigate() commits, so a re-render here would see "no token" and fire
  // <Navigate to="/"> — racing (and sometimes beating) the deliberate redirect
  // to the login page. Render nothing and let the logout's own navigation win
  // (the "Logging out…" overlay covers the blank frame).
  if (isLoggingOut) {
    return null;
  }

  // ✅ Fallback-session rehydration for the tab that originally owned the socket
  if (!token && activeSocketTabId === tabId) {
    const fallbackRole  = localStorage.getItem("fallbackBranchRole");
    const fallbackEmail = localStorage.getItem("fallbackBranchEmail");

    if (fallbackRole && fallbackEmail) {
      console.info("[ProtectedRoute] ✅ Rehydrating fallback session (tab owner)");

      sessionStorage.setItem("branchAdminRole",  fallbackRole);
      sessionStorage.setItem("branchEmail",      fallbackEmail);
      sessionStorage.setItem("branchId",         localStorage.getItem("fallbackBranchId")   || "");
      sessionStorage.setItem("branchName",       localStorage.getItem("fallbackBranchName") || "Branch Admin");
      if (!sessionStorage.getItem("branchAdminToken")) {
        sessionStorage.setItem("branchAdminToken", "__FALLBACK_FAKE_TOKEN__");
      }
      return children;
    }

    console.warn("[ProtectedRoute] ❌ Socket owner missing fallback values. Redirecting.");
    return <Navigate to={redirectPath} replace />;
  }

  // ❌ No token at all
  if (!token) {
    console.warn("[ProtectedRoute] ❌ No token found. Redirecting.");
    return <Navigate to={redirectPath} replace />;
  }

  // ❌ Fallback token on a non-owning tab is not allowed
  if (isFallbackToken && activeSocketTabId !== tabId) {
    console.warn("[ProtectedRoute] ❌ Fallback token used on non-owning tab. Redirecting.");
    return <Navigate to={redirectPath} replace />;
  }

  // ❌ Role mismatch
  if (requiredRole && role !== requiredRole) {
    console.warn(
      `[ProtectedRoute] ❌ Role mismatch. Required: ${requiredRole}, Found: ${role}`
    );
    return <Navigate to={redirectPath} replace />;
  }

  // ✅ All checks passed
  return children;
};

export default React.memo(ProtectedRoute);