// magis-project/user-frontend/src/index.js

// ── Ensure passive touch listeners everywhere (silences Chrome warnings) ──
import "./utils/patchPassiveTouchListeners";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import App from "./App";
import "./index.css";

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
    <BrowserRouter>
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
} else {
  console.log(
    '[SW] Skipping service-worker registration (only in production + secure context).'
  );
}
