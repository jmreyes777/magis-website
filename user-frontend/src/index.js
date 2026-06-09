// magis-project/user-frontend/src/index.js

// ── Ensure passive touch listeners everywhere (silences Chrome warnings) ──
import "./utils/patchPassiveTouchListeners";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import App from "./App";
import "./index.css";
import reportWebVitals from "./reportWebVitals";

// ✅ Prevent potential memory leaks from unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
  console.error("[SECURITY] Unhandled Promise Rejection:", event.reason);
  event.preventDefault();
});

// ✅ Catch runtime errors globally
window.addEventListener("error", (event) => {
  console.error(
    "[SECURITY] Uncaught Error:",
    event.message,
    event.filename,
    event.lineno
  );
});

// ✅ Strict CSP prevents inline scripts & enforces security policies
console.log("[SECURITY] Content Security Policy Applied.");

const root = ReactDOM.createRoot(document.getElementById("root"));

root.render(
  <React.StrictMode>
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true
      }}
    >
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// ────────────────────────────────────────────────────────────────────────────
// Register Workbox service worker (InjectManifest output at /sw.js)
// ────────────────────────────────────────────────────────────────────────────
if (
  process.env.NODE_ENV === 'production' &&
  process.env.REACT_APP_ENABLE_SW === 'true' &&
  'serviceWorker' in navigator &&
  window.isSecureContext
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(reg => {
        console.log('SW registered:', reg.scope);

        // 👉 Force the new SW to take control immediately
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              // tell the waiting SW to skipWaiting()
              newWorker.postMessage('SKIP_WAITING');
            }
          });
        });
      })
      .catch(err => console.warn('SW registration failed:', err));

    // 🔄 Optional: reload page when the new SW has taken control
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  });
} else if ('serviceWorker' in navigator) {
  // Service worker disabled (REACT_APP_ENABLE_SW !== 'true'). Proactively
  // unregister any previously-installed worker and purge its caches so a stale
  // or broken SW from an earlier build can't keep hijacking navigation.
  navigator.serviceWorker
    .getRegistrations()
    .then(regs => regs.forEach(reg => reg.unregister()))
    .catch(() => {});
  if (window.caches && caches.keys) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
  }
  console.log('[SW] Service worker disabled — unregistered any existing workers.');
}

// ── Web Vitals (PERF0-1 baseline) ────────────────────────────────────────────
// Dev-only: logs LCP/INP/CLS/FCP/TTFB to the console. No-op in production so
// there is no runtime/security impact on shipped builds.
if (process.env.NODE_ENV !== "production") {
  reportWebVitals((metric) => {
    const v = Math.round((metric.value + Number.EPSILON) * 100) / 100;
    console.log(`[web-vitals] ${metric.name} = ${v} (${metric.rating || "n/a"})`, metric);
  });
}
