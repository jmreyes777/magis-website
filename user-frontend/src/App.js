import React, { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import { Helmet, HelmetProvider } from "react-helmet-async";
import ScrollToTop from "./Shared/ScrollToTop-Component";
import ErrorBoundary from "./Shared/ErrorBoundary-Component";
import Header from "./components/Header-User-Component";

// Public Components. Import thunks are declared once so the lazy() routes and
// the idle-time prefetcher (SPD3-1) share the same chunk requests.
const routeImports = {
  home: () => import("./pages/Home-User-Page"),
  contact: () => import("./pages/ContactUs-User-Page"),
  branches: () => import("./pages/Branches-List-User-Page"),
  terms: () => import("./pages/Terms-Conditions-User-Page"),
  privacy: () => import("./pages/Footer-Privacy-Policy-User-Page"),
  faqs: () => import("./pages/FAQS-User-Page"),
  pawning: () => import("./pages/Pawn-Service-User-Page"),
  jewelry: () => import("./pages/Jewelry-Sales-User-Page"),
  notFound: () => import("./pages/NotFound-User-Page"),
};
const Home = lazy(routeImports.home);
const ContactUs = lazy(routeImports.contact);
const BranchesMapView = lazy(routeImports.branches);
const Terms = lazy(routeImports.terms);
const PrivacyPolicy = lazy(routeImports.privacy);
const FAQsUserPage = lazy(routeImports.faqs);
const Pawning = lazy(routeImports.pawning);
const JewelrySales = lazy(routeImports.jewelry);
const NotFound = lazy(routeImports.notFound);

// SPD3-1 (speed megaplan): once the current page is fully loaded and the
// browser is idle, warm the OTHER route chunks so in-site navigation is
// instant. Skips constrained connections (Save-Data / 2g) and never runs
// more than once. Chunks land in the HTTP cache (and the SW cache when
// enabled); failures are silently ignored.
let prefetched = false;
function prefetchRoutesWhenIdle() {
  if (prefetched) return;
  prefetched = true;
  const conn = navigator.connection || {};
  if (conn.saveData || /(^|\b)2g/.test(conn.effectiveType || "")) return;
  const kick = () => {
    Object.values(routeImports).forEach((imp) => {
      try { imp().catch(() => {}); } catch { /* ignore */ }
    });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(kick, { timeout: 10000 });
  else setTimeout(kick, 3000);
}

function App() {
  const [branchStatuses, setBranchStatuses] = useState({}); // Tracks branch online/offline statuses

  // SPD3-1: prefetch route chunks after load, off the critical path.
  useEffect(() => {
    if (document.readyState === "complete") {
      prefetchRoutesWhenIdle();
      return;
    }
    window.addEventListener("load", prefetchRoutesWhenIdle, { once: true });
    return () => window.removeEventListener("load", prefetchRoutesWhenIdle);
  }, []);

  return (
    <HelmetProvider>
      <div className="app-wrapper">
        {/* Header - Fixed at top */}
        <Header />

        {/* Scroll Restoration */}
        <ScrollToTop />

        {/* Default document title (overridden per-page by <Seo>) */}
        <Helmet defaultTitle="Magis Gold & Gems Pawnshop & Jewelry" />

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
                {/* 404 — real Not Found page (noindex) instead of a soft-404 redirect */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ErrorBoundary>
          </Suspense>
        </main>
      </div>
    </HelmetProvider>
  );
}

export default App;
