//magis-edge-worker/src/App.js

import React, { lazy, Suspense, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Helmet, HelmetProvider } from "react-helmet-async";
import ScrollToTop from "./Shared/ScrollToTop-Component";
import ErrorBoundary from "./Shared/ErrorBoundary-Component";

// Public Components
const Home = lazy(() => import("./pages/Home-User-Page"));
const ContactUs = lazy(() => import("./pages/ContactUs-User-Page"));
const BranchesMapView = lazy(() => import("./pages/Branches-List-User-Page"));

function App() {
  const [branchStatuses, setBranchStatuses] = useState({}); // Tracks branch online/offline statuses

  return (
    <HelmetProvider>
      <div className="app-wrapper">
        {/* Scroll Restoration */}
        <ScrollToTop />

        {/* Helmet for Document Title */}
        <Helmet>
          <title>Magis Project</title>
        </Helmet>

        {/* Main Content */}
        <main className="content">
          <Suspense fallback={<div className="loading-screen">Loading...</div>}>
            <ErrorBoundary>
              <Routes>
                {/* Public User Routes */}
                <Route
                  path="/"
                  element={<Home branchStatuses={branchStatuses} />}
                />
                <Route
                  path="/branches"
                  element={<BranchesMapView branchStatuses={branchStatuses} />}
                />
                <Route
                  path="/contact-us"
                  element={<ContactUs branchStatuses={branchStatuses} />}
                />

                {/* Fallback Route */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ErrorBoundary>
          </Suspense>
        </main>
      </div>
    </HelmetProvider>
  );
}

export default App;