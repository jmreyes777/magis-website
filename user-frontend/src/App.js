import React, { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import { Helmet, HelmetProvider } from "react-helmet-async";
import ScrollToTop from "./Shared/ScrollToTop-Component";
import ErrorBoundary from "./Shared/ErrorBoundary-Component";
import Header from "./components/Header-User-Component";
import GuestCsatToast from "./components/Guest-Csat-Toast";

// Public Components. Import thunks are declared once so the lazy() routes and
// the idle-time prefetcher (SPD3-1) share the same chunk requests.
const routeImports = {
  home: () => import("./pages/Home-User-Page"),
  contact: () => import("./pages/ContactUs-User-Page"),
  about: () => import("./pages/About-Us-User-Page"),
  branches: () => import("./pages/Branches-List-User-Page"),
  terms: () => import("./pages/Terms-Conditions-User-Page"),
  privacy: () => import("./pages/Footer-Privacy-Policy-User-Page"),
  faqs: () => import("./pages/FAQS-User-Page"),
  pawning: () => import("./pages/Pawn-Service-User-Page"),
  jewelry: () => import("./pages/Jewelry-Sales-User-Page"),
  notFound: () => import("./pages/NotFound-User-Page"),
  // SEO megaplan W2: all four guides live in ONE module/chunk (shared template
  // + CSS); the thunk is listed once so the idle prefetcher warms it once.
  guides: () => import("./pages/guides/Guides-User-Page"),
};
// SEO prerender (W3): React 18 can't cleanly hydrate a Suspense boundary that
// SUSPENDS over client-captured snapshot HTML (no SSR boundary markers →
// minified errors #418/#423 + a re-render flash). lazyPreload() lets index.js
// resolve the route chunk BEFORE hydrateRoot() so the first render is fully
// synchronous. CSR is untouched: until preload() completes, the component is
// the exact same React.lazy as before — and preload() is only ever called on
// the pre-hydration path (never mid-session, so element identity is stable).
function lazyPreload(thunk, pick = (m) => m.default) {
  const Lazy = lazy(() => thunk().then((m) => ({ default: pick(m) })));
  let Loaded = null;
  const Component = (props) =>
    Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  Component.preload = () =>
    thunk().then((m) => {
      Loaded = pick(m);
    });
  return Component;
}

const Home = lazyPreload(routeImports.home);
const ContactUs = lazyPreload(routeImports.contact);
const AboutUs = lazyPreload(routeImports.about);
const BranchesMapView = lazyPreload(routeImports.branches);
const Terms = lazyPreload(routeImports.terms);
const PrivacyPolicy = lazyPreload(routeImports.privacy);
const FAQsUserPage = lazyPreload(routeImports.faqs);
const Pawning = lazyPreload(routeImports.pawning);
const JewelrySales = lazyPreload(routeImports.jewelry);
const NotFound = lazyPreload(routeImports.notFound);
const GoldPricesGuide = lazyPreload(routeImports.guides, (m) => m.GoldPricesGuide);
const HowToPawnGuide = lazyPreload(routeImports.guides, (m) => m.HowToPawnGuide);
const KaratGuide = lazyPreload(routeImports.guides, (m) => m.KaratGuide);
const InterestRatesGuide = lazyPreload(routeImports.guides, (m) => m.InterestRatesGuide);

// Map a pathname to its route component's preload() — used by index.js on
// prerendered pages only. Unknown paths resolve immediately (no-op).
export function preloadRouteForPath(pathname) {
  const key = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const table = {
    "/": Home,
    "/branches": BranchesMapView,
    "/contact-us": ContactUs,
    "/about-us": AboutUs,
    "/terms": Terms,
    "/privacy-policy": PrivacyPolicy,
    "/faqs": FAQsUserPage,
    "/pawning": Pawning,
    "/jewelry-sales": JewelrySales,
    "/guides/gold-prices-appraisal": GoldPricesGuide,
    "/guides/how-to-pawn": HowToPawnGuide,
    "/guides/gold-karat-guide": KaratGuide,
    "/guides/pawnshop-interest-rates": InterestRatesGuide,
  };
  const C = key.startsWith("/branches/") ? BranchesMapView : table[key];
  return C && C.preload ? C.preload().catch(() => {}) : Promise.resolve();
}

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
                {/* Per-branch deep link (GBP Website targets — BRANCH-GBP-LINKS-PLAN.md).
                    Same page component; it resolves :slug → branch, focuses it,
                    emits per-branch SEO, and honors ?chat=1. */}
                <Route path="/branches/:slug" element={<BranchesMapView branchStatuses={branchStatuses} />} />

                <Route path="/contact-us" element={<ContactUs branchStatuses={branchStatuses} />} />
                <Route path="/about-us" element={<AboutUs />} />
                <Route path="/terms" element={<Terms branchStatuses={branchStatuses} />} />
                <Route path="/privacy-policy" element={<PrivacyPolicy branchStatuses={branchStatuses} />} />
                <Route path="/faqs" element={<FAQsUserPage branchStatuses={branchStatuses} />} />
                <Route path="/pawning" element={<Pawning />} />
                <Route path="/jewelry-sales" element={<JewelrySales />} />

                {/* SEO megaplan W2 — keyword-targeted guide hub (bilingual). */}
                <Route path="/guides/gold-prices-appraisal" element={<GoldPricesGuide />} />
                <Route path="/guides/how-to-pawn" element={<HowToPawnGuide />} />
                <Route path="/guides/gold-karat-guide" element={<KaratGuide />} />
                <Route path="/guides/pawnshop-interest-rates" element={<InterestRatesGuide />} />
                {/* 404 — real Not Found page (noindex) instead of a soft-404 redirect */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ErrorBoundary>
          </Suspense>
        </main>

        {/* CHATUX2: post-chat rating toast — renders nothing until an eligible
            chat close dispatches the magis:csat event (utils/csat.js). Lives
            outside <Routes> so it survives navigation while fading out. */}
        <GuestCsatToast />
      </div>
    </HelmetProvider>
  );
}

export default App;
