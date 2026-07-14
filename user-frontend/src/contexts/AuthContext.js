//magis-project/user-frontend/src/contexts/AuthContext.js

import React, { createContext, useState, useContext, useEffect } from "react";
import { jwtDecode } from "jwt-decode";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const SUPER_ADMIN_TOKEN_KEY = "superAdminToken";
  const SUPER_ADMIN_ROLE_KEY = "superAdminRole";
  const BRANCH_ADMIN_TOKEN_KEY = "branchAdminToken";
  const BRANCH_ADMIN_ROLE_KEY = "branchAdminRole";

  // Token checks are pure synchronous storage reads, so the initial auth state
  // can be computed during the first render. This removes the old
  // "Initializing..." placeholder frame entirely (faster first paint) and is
  // REQUIRED for SEO prerender hydration: hydrateRoot() must produce the real
  // page on the first render pass, not a loading gate that mismatches the
  // prerendered HTML. Side effects (clearing expired tokens) stay in the
  // useEffect below — this initializer only READS.
  const computeInitialAuth = () => {
    try {
      let token =
        sessionStorage.getItem(SUPER_ADMIN_TOKEN_KEY) ||
        localStorage.getItem(SUPER_ADMIN_TOKEN_KEY);
      let role = token ? "superadmin" : null;
      if (!token) {
        token =
          sessionStorage.getItem(BRANCH_ADMIN_TOKEN_KEY) ||
          localStorage.getItem(BRANCH_ADMIN_TOKEN_KEY);
        role = token ? "branchadmin" : null;
      }
      if (token) {
        const decodedToken = jwtDecode(token);
        if (decodedToken.exp * 1000 > Date.now()) {
          return { isAuthenticated: true, userRole: role };
        }
      }
    } catch {
      /* invalid token → unauthenticated; useEffect handles cleanup */
    }
    return { isAuthenticated: false, userRole: null };
  };
  const initialAuth = computeInitialAuth();

  const [isAuthenticated, setIsAuthenticated] = useState(initialAuth.isAuthenticated);
  const [userRole, setUserRole] = useState(initialAuth.userRole);

  const checkAuthentication = () => {
    try {
      let token = null;
      let role = null;

      // Check tokens
      if (sessionStorage.getItem(SUPER_ADMIN_TOKEN_KEY) || localStorage.getItem(SUPER_ADMIN_TOKEN_KEY)) {
        token = sessionStorage.getItem(SUPER_ADMIN_TOKEN_KEY) || localStorage.getItem(SUPER_ADMIN_TOKEN_KEY);
        role = "superadmin";
      } else if (
        sessionStorage.getItem(BRANCH_ADMIN_TOKEN_KEY) || localStorage.getItem(BRANCH_ADMIN_TOKEN_KEY)
      ) {
        token = sessionStorage.getItem(BRANCH_ADMIN_TOKEN_KEY) || localStorage.getItem(BRANCH_ADMIN_TOKEN_KEY);
        role = "branchadmin";
      }

      // Validate token
      if (token) {
        const decodedToken = jwtDecode(token);
        if (decodedToken.exp * 1000 > Date.now()) {
          setIsAuthenticated(true);
          setUserRole(role);
        } else {
          logout();
        }
      } else {
        logout();
      }
    } catch (error) {
      console.error("[ERROR] Token validation failed:", error.message);
      logout();
    }
  };

  const logout = () => {
    sessionStorage.clear();
    localStorage.clear();
    setIsAuthenticated(false);
    setUserRole(null);
  };

  useEffect(() => {
    checkAuthentication();
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, userRole, logout, checkAuthentication }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);