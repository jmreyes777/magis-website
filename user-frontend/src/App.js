import React, { lazy, Suspense, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Helmet, HelmetProvider } from "react-helmet-async";
import ScrollToTop from "./Shared/ScrollToTop-Component";
import ErrorBoundary from "./Shared/ErrorBoundary-Component";
import Header from "./components/Header-User-Component";

// Public Components
const Home = lazy(() => import("./pages/Home-User-Page"));
const ContactUs = lazy(() => import("./pages/ContactUs-User-Page"));
const BranchesMapView = lazy(() => import("./pages/Branches-List-User-Page"));
const Terms = lazy(() => import("./pages/Terms-Conditions-User-Page"));
const PrivacyPolicy = lazy(() => import("./pages/Footer-Privacy-Policy-User-Page"));
const FAQsUserPage = lazy(() => import("./pages/FAQS-User-Page"));
const Pawning = lazy(() => import("./pages/Pawn-Service-User-Page"));
const JewelrySales = lazy(() => import("./pages/Jewelry-Sales-User-Page"));

function App() {
  const [branchStatuses, setBranchStatuses] = useState({}); // Tracks branch online/offline statuses

  return (
    <HelmetProvider>
      <div className="app-wrapper">
        {/* Header - Fixed at top */}
        <Header />

        {/* Scroll Restoration */}
        <ScrollToTop />

        {/* Helmet for Document Title */}
        <Helmet>
          <title>Magis Website</title>
        </Helmet>

        {/* Main Content (pushes & dims when mobile drawer is open) */}
        <main className="content site-content">
          <Suspense fallback={<div className="loading-screen">Loading...</div>}>
            <ErrorBoundary>
              <Routes>
                {/* Public User Routes */}
                <Route path="/" element={<Home branchStatuses={branchStatuses} />} />
                <Route path="/branches" element={<BranchesMapView branchStatuses={branchStatuses} />} />

                <Route path="/contact-us" element={<ContactUs branchStatuses={branchStatuses} />} />
                <Route path="/terms" element={<Terms branchStatuses={branchStatuses} />} />
                <Route path="/privacy-policy" element={<PrivacyPolicy branchStatuses={branchStatuses} />} />
                <Route path="/faqs" element={<FAQsUserPage branchStatuses={branchStatuses} />} />
                <Route path="/pawning" element={<Pawning />} />
                <Route path="/jewelry-sales" element={<JewelrySales />} />
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
