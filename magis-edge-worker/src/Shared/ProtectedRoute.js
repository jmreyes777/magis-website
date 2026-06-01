//magis-project/user-frontend/src/Shared/ProtectedRoute.js

import React from "react";
import { Navigate } from "react-router-dom";
import { jwtDecode } from "jwt-decode";

/**
 * ProtectedRoute Component
 * Protects routes by verifying authentication status and role.
 * @param {Object} props - Component props.
 * @param {ReactNode} props.children - Protected child components.
 * @param {string} [props.requiredRole] - Role required to access the route.
 * @param {string} [props.redirectPath="/"] - Path to redirect unauthenticated/unauthorized users.
 */
const ProtectedRoute = ({ children, requiredRole = null, redirectPath = "/" }) => {
  console.log("[DEBUG] ProtectedRoute: Checking access...");

  try {
    let token = null;
    let userRole = null;

    // Step 1: Retrieve tokens and roles based on requiredRole
    if (requiredRole === "superadmin") {
      token =
        sessionStorage.getItem("superAdminToken") || localStorage.getItem("superAdminToken");
      userRole =
        sessionStorage.getItem("superAdminRole") || localStorage.getItem("superAdminRole");
    } else if (requiredRole === "branchadmin") {
      token =
        sessionStorage.getItem("branchAdminToken") || localStorage.getItem("branchAdminToken");
      userRole =
        sessionStorage.getItem("branchAdminRole") || localStorage.getItem("branchAdminRole");
    }

    // Step 2: Validate token presence
    if (!token) {
      console.warn("[WARNING] No authentication token found. Redirecting to login...");
      clearAuthStorage();
      return <Navigate to={redirectPath} replace />;
    }

    // Step 3: Decode and validate token
    const decodedToken = jwtDecode(token);
    console.log("[DEBUG] Decoded Token:", decodedToken);

    if (!decodedToken || decodedToken.exp * 1000 < Date.now()) {
      console.warn("[WARNING] Token has expired. Clearing storage and redirecting...");
      clearAuthStorage();
      return <Navigate to={redirectPath} replace />;
    }

    // Step 4: Verify user role
    if (requiredRole && userRole !== requiredRole) {
      console.warn(
        `[WARNING] Access denied. Required role: '${requiredRole}', current role: '${userRole}'. Redirecting to login...`
      );
      return <Navigate to={redirectPath} replace />;
    }

    console.info("[INFO] Access granted. Rendering protected route.");
    return children;
  } catch (error) {
    console.error("[ERROR] Token validation failed. Clearing storage and redirecting...", error);
    clearAuthStorage();
    return <Navigate to={redirectPath} replace />;
  }
};

/**
 * Clears authentication data specific to both roles from storage.
 */
const clearAuthStorage = () => {
  // Clear Super Admin Storage
  sessionStorage.removeItem("superAdminToken");
  sessionStorage.removeItem("superAdminRole");
  localStorage.removeItem("superAdminToken");
  localStorage.removeItem("superAdminRole");

  // Clear Branch Admin Storage
  sessionStorage.removeItem("branchAdminToken");
  sessionStorage.removeItem("branchAdminRole");
  localStorage.removeItem("branchAdminToken");
  localStorage.removeItem("branchAdminRole");

  console.info("[INFO] Cleared all authentication data.");
};

export default ProtectedRoute;