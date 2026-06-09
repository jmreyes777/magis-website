// Version-agnostic Web Vitals reporter (PERF0-1).
// Supports web-vitals v2 (getCLS/getFID/...) and v3+/v4 (onCLS/onINP/...),
// so INP is captured automatically wherever web-vitals >= 3 is installed.
const reportWebVitals = (onPerfEntry) => {
  if (!(onPerfEntry instanceof Function)) return;
  import("web-vitals").then((vitals) => {
    const bind = (fn) => {
      if (typeof fn === "function") fn(onPerfEntry);
    };
    bind(vitals.onCLS || vitals.getCLS);
    bind(vitals.onLCP || vitals.getLCP);
    bind(vitals.onFCP || vitals.getFCP);
    bind(vitals.onTTFB || vitals.getTTFB);
    bind(vitals.onINP); // v3+ only (Interaction to Next Paint)
    bind(vitals.onFID || vitals.getFID); // v2/v3 (removed in v4)
  });
};

export default reportWebVitals;
