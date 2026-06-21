// magis-project/admin-frontend/src/App.js

import React, { lazy, Suspense, useContext, useState, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Helmet, HelmetProvider } from "react-helmet-async";
import ScrollToTop from "./components/ScrollToTop-Component";
import ErrorBoundary from "./components/ErrorBoundary-Component";
import ProtectedRoute from "./components/ProtectedRoute";
import { GoogleReCaptchaProvider } from "react-google-recaptcha-v3";
import AuthContext from "./context/AuthContext";

// Lazy-loaded Admin Components
const BranchLogin = lazy(() => import("./pages/Branch-Unified-Login")); // unified Staff + Branch-Admin login
const SuperAdminLogin = lazy(() => import("./pages/SuperAdminLogin"));
const BranchManagement = lazy(() => import("./pages/Admin-Page-Branch-Add-Edit-Interface"));
const BranchesList = lazy(() => import("./pages/Admin-Page-BranchesList-with-Add-Edit-Delete-buttons"));
const StaffManagement = lazy(() => import("./pages/Admin-Page-Staff-Management"));
const BranchPasswords = lazy(() => import("./pages/Admin-Page-Branch-Passwords"));
const BranchChatDashboard = lazy(() => import("./pages/Branch-Chat-Dashboard"));
const BranchAdminAnalytics = lazy(() => import("./pages/BranchAdmin-Analytics-Page"));
const LandingPage = lazy(() => import("./pages/LandingPage")); // Neutral landing page

function App() {
  const { isInitialized } = useContext(AuthContext);
  const [ready, setReady] = useState(false);

  // ⏳ Wait for AuthContext to finish before showing routes
  useEffect(() => {
    if (isInitialized) {
      setTimeout(() => setReady(true), 100); // allow sessionStorage to hydrate
    }
  }, [isInitialized]);

  if (!ready) {
    return <div className="loading-screen">Initializing Securely...</div>;
  }

  return (
    <HelmetProvider>
      <Helmet>
        <title>Admin Panel - Secure</title>
      </Helmet>

      <GoogleReCaptchaProvider
        reCaptchaKey={process.env.REACT_APP_RECAPTCHA_SITE_KEY || ""}
        scriptProps={{
          async: true,
          defer: true,
          appendTo: "body",
          nonce: "xyz123",
        }}
        explicit={true}
        useRecaptchaNet={false}
      >
        <RoutesComponent />
      </GoogleReCaptchaProvider>
    </HelmetProvider>
  );
}

const RoutesComponent = () => {
  return (
    <div className="app-wrapper">
      <ScrollToTop />
      <main className="content">
        <Suspense fallback={<div className="loading-screen">Loading Securely...</div>}>
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/branch-admin-login" element={<BranchLogin />} />
              <Route path="/super-admin-login" element={<SuperAdminLogin />} />
              <Route path="/staff-login" element={<BranchLogin />} />

              <Route
                path="/admin/branches"
                element={
                  <ProtectedRoute requiredRole="superadmin">
                    <BranchesList />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/branches/new"
                element={
                  <ProtectedRoute requiredRole="superadmin">
                    <BranchManagement />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/branches/edit/:branchId"
                element={
                  <ProtectedRoute requiredRole="superadmin">
                    <BranchManagement />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/staff"
                element={
                  <ProtectedRoute requiredRole="superadmin">
                    <StaffManagement />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/branch-passwords"
                element={
                  <ProtectedRoute requiredRole="superadmin">
                    <BranchPasswords />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/admin/chats"
                element={
                  <ProtectedRoute requiredRole="branchadmin">
                    <BranchChatDashboard />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/admin/analytics"
                element={
                  <ProtectedRoute requiredRole="branchadmin">
                    <BranchAdminAnalytics />
                  </ProtectedRoute>
                }
              />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </Suspense>
      </main>
    </div>
  );
};

export default App;
