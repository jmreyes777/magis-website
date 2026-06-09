// Admin index.js

// ✅ All imports first (ESLint: import/first)
import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css"; // Tailwind or global styles
import "./styles/admin-dashboard.css"; // Admin dashboard brand colors
import "./styles/branch-chat-dashboard-modern.css"; // Branch chat dashboard modernization
import ErrorBoundary from "./components/ErrorBoundary-Component";
import { AuthProvider } from "./context/AuthContext";
import reportWebVitals from "./reportWebVitals";

// ─── Silence internal Timeout (b) & handleError logs globally ───
// 1) Unhandled promise rejections
window.addEventListener("unhandledrejection", event => {
  const err = event.reason;
  if (err && err.message === "Timeout (b)") {
    event.preventDefault();
  }
});

// 2) Global errors
window.addEventListener("error", event => {
  const err = event.error;
  if (err && err.message === "Timeout (b)") {
    event.preventDefault();
  }
});

// 3) Patch console.error to filter any Timeout or handleError lines
const _origConsoleError = console.error;
console.error = (...args) => {
  const first = args[0];
  if (
    (typeof first === "string" && first.includes("Timeout (b)")) ||
    (typeof first === "string" && first.includes("handleError"))
  ) {
    return; // drop it
  }
  _origConsoleError(...args);
};
// ────────────────────────────────────────────────────────────────

const rootElement = document.getElementById("root");
if (!rootElement) {
  console.error("[SECURITY] ❌ CRITICAL ERROR: Root element not found!");
  throw new Error("React root element not found. Application will not load.");
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<div className="loading-screen">Loading Securely...</div>}>
            <App />
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

// ── Web Vitals (PERF0-1 baseline) ────────────────────────────────────────────
// Dev-only: logs LCP/INP/CLS/FCP/TTFB to the console. No-op in production so
// there is no runtime/security impact on shipped builds.
if (process.env.NODE_ENV !== "production") {
  reportWebVitals((metric) => {
    const v = Math.round((metric.value + Number.EPSILON) * 100) / 100;
    console.log(`[web-vitals] ${metric.name} = ${v} (${metric.rating || "n/a"})`, metric);
  });
}
