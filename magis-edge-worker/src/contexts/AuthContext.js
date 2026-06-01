//magis-project/user-frontend/src/contexts/AuthContext.js

import React, { createContext, useState, useContext, useEffect } from "react";
import { jwtDecode } from "jwt-decode";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const SUPER_ADMIN_TOKEN_KEY = "superAdminToken";
  const SUPER_ADMIN_ROLE_KEY = "superAdminRole";
  const BRANCH_ADMIN_TOKEN_KEY = "branchAdminToken";
  const BRANCH_ADMIN_ROLE_KEY = "branchAdminRole";

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);

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
    } finally {
      setIsInitialized(true);
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
      {isInitialized ? children : <div>Initializing...</div>}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);