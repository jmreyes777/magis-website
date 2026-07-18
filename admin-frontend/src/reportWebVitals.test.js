// ADM3 — reportWebVitals version-agnosticism guardrail.
//
// CRA's stock reportWebVitals broke on web-vitals major bumps because it
// imported version-specific helpers by name (v5 removed onFID, v4 removed
// the v2 get* family). Ours binds whatever shape is installed. This suite
// drives the exported bindWebVitals against every historical module shape,
// so Dependabot web-vitals majors stay mergeable without a browser test.
//
// (bindWebVitals is exported precisely for this test — CRA's jest 27 cannot
// intercept the module's internal dynamic import.)

import reportWebVitals, { bindWebVitals } from "./reportWebVitals";

test("default export: non-function argument is a silent no-op", () => {
  expect(() => reportWebVitals(undefined)).not.toThrow();
  expect(() => reportWebVitals("not a function")).not.toThrow();
  expect(() => reportWebVitals(null)).not.toThrow();
});

test("web-vitals v4 shape: all on* helpers bound, including onINP and onFID", () => {
  const shape = {
    onCLS: jest.fn(),
    onLCP: jest.fn(),
    onFCP: jest.fn(),
    onTTFB: jest.fn(),
    onINP: jest.fn(),
    onFID: jest.fn(),
  };
  const sink = jest.fn();
  bindWebVitals(shape, sink);
  for (const fn of Object.values(shape)) {
    expect(fn).toHaveBeenCalledWith(sink);
  }
});

test("web-vitals v5 shape (onFID removed): binds the rest without crashing", () => {
  const shape = {
    onCLS: jest.fn(),
    onLCP: jest.fn(),
    onFCP: jest.fn(),
    onTTFB: jest.fn(),
    onINP: jest.fn(),
  };
  const sink = jest.fn();
  expect(() => bindWebVitals(shape, sink)).not.toThrow();
  for (const fn of Object.values(shape)) {
    expect(fn).toHaveBeenCalledWith(sink);
  }
});

test("web-vitals v2 shape (get* helpers): classic metrics still reported", () => {
  const shape = {
    getCLS: jest.fn(),
    getLCP: jest.fn(),
    getFCP: jest.fn(),
    getTTFB: jest.fn(),
    getFID: jest.fn(),
  };
  const sink = jest.fn();
  bindWebVitals(shape, sink);
  for (const fn of Object.values(shape)) {
    expect(fn).toHaveBeenCalledWith(sink);
  }
});

test("on* is preferred over get* when a module exposes both", () => {
  const shape = { onCLS: jest.fn(), getCLS: jest.fn() };
  bindWebVitals(shape, jest.fn());
  expect(shape.onCLS).toHaveBeenCalled();
  expect(shape.getCLS).not.toHaveBeenCalled();
});

test("empty module (hypothetical v6 rename-everything) is survivable", () => {
  expect(() => bindWebVitals({}, jest.fn())).not.toThrow();
});
