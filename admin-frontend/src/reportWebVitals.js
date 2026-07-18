// Version-agnostic Web Vitals reporter (PERF0-1).
// Supports web-vitals v2 (getCLS/getFID/...), v3/v4 (onCLS/onINP/...), and
// v5 (onFID removed), so INP is captured wherever web-vitals >= 3 is
// installed and no removed helper can break the import.
// Binding logic is exported for the ADM3 guardrail test (CRA's jest cannot
// intercept this module's dynamic import).
export function bindWebVitals(vitals, onPerfEntry) {
  const bind = (fn) => {
    if (typeof fn === "function") fn(onPerfEntry);
  };
  bind(vitals.onCLS || vitals.getCLS);
  bind(vitals.onLCP || vitals.getLCP);
  bind(vitals.onFCP || vitals.getFCP);
  bind(vitals.onTTFB || vitals.getTTFB);
  bind(vitals.onINP); // v3+ only (Interaction to Next Paint)
  bind(vitals.onFID || vitals.getFID); // v2/v3 (deprecated v4, removed in v5)
}

const reportWebVitals = (onPerfEntry) => {
  if (!(onPerfEntry instanceof Function)) return;
  import("web-vitals").then((vitals) => bindWebVitals(vitals, onPerfEntry));
};

export default reportWebVitals;
