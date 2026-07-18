// ADM1 — session bootstrap utilities.
//
// These three utils gate every admin login flow: tab identity (initSession),
// polling for the session token (waitForSessionReady), and hydration with the
// in-memory fallback (ensureSessionHydrated). All state lives in
// window/sessionStorage/localStorage, which jsdom provides natively.
//
// Real timers throughout: the polling helpers take/contain short enough
// budgets that shrinking maxAttempts keeps tests fast, and CRA's jest 27
// lacks advanceTimersByTimeAsync for async-loop fakes.

import { getSessionIds, getSessionTabId } from "./initSession";
import { waitForSessionReady } from "./waitForSessionReady";
import { ensureSessionHydrated } from "./sessionHydration";

beforeEach(() => {
  window.name = "";
  sessionStorage.clear();
  localStorage.clear();
  delete window.__LAST_HYDRATED_TOKEN__;
  delete window.__LAST_HYDRATED_EMAIL__;
});

describe("getSessionIds (tab identity)", () => {
  test("mints a sessionTabId into window.name when absent", () => {
    const { sessionTabId } = getSessionIds();
    expect(sessionTabId).toMatch(/^sessionTabId-[0-9a-f-]{36}$/);
    expect(window.name).toBe(sessionTabId);
  });

  test("preserves an existing sessionTabId (tab identity is sticky)", () => {
    const first = getSessionIds().sessionTabId;
    const second = getSessionIds().sessionTabId;
    expect(second).toBe(first);
    expect(getSessionTabId()).toBe(first);
  });

  test("replaces a foreign window.name (e.g. set by window.open)", () => {
    window.name = "some-other-page-name";
    const { sessionTabId } = getSessionIds();
    expect(sessionTabId).toMatch(/^sessionTabId-/);
  });

  test("tabId persists in localStorage across calls", () => {
    const { tabId } = getSessionIds();
    expect(tabId).toMatch(/^tabId-/);
    expect(localStorage.getItem("tabId")).toBe(tabId);
    expect(getSessionIds().tabId).toBe(tabId);
  });
});

describe("waitForSessionReady (token polling)", () => {
  test("resolves immediately when token+email already present", async () => {
    sessionStorage.setItem("branchAdminToken", "tok-1");
    sessionStorage.setItem("branchEmail", "a@b.ph");
    const started = Date.now();
    const res = await waitForSessionReady();
    expect(res).toEqual({ token: "tok-1", email: "a@b.ph" });
    expect(Date.now() - started).toBeLessThan(140); // no 150ms sleep taken
  });

  test("picks up a token that appears mid-poll", async () => {
    setTimeout(() => {
      sessionStorage.setItem("branchAdminToken", "tok-2");
      sessionStorage.setItem("branchEmail", "late@b.ph");
    }, 200);
    const res = await waitForSessionReady(5);
    expect(res).toEqual({ token: "tok-2", email: "late@b.ph" });
  });

  test("token without email is NOT ready (both required)", async () => {
    sessionStorage.setItem("branchAdminToken", "tok-3");
    const res = await waitForSessionReady(2);
    expect(res).toEqual({ token: null, email: null });
  });

  test("gives up with nulls after maxAttempts", async () => {
    const res = await waitForSessionReady(2);
    expect(res).toEqual({ token: null, email: null });
  });
});

describe("ensureSessionHydrated", () => {
  test("resolves fully-hydrated from sessionStorage without waiting", async () => {
    sessionStorage.setItem("branchAdminToken", "tok");
    sessionStorage.setItem("branchEmail", "e@b.ph");
    sessionStorage.setItem("branchId", "BR-1");
    sessionStorage.setItem("branchName", "Makati");
    const res = await ensureSessionHydrated();
    expect(res).toEqual({
      token: "tok",
      email: "e@b.ph",
      id: "BR-1",
      name: "Makati",
      hydrated: true,
    });
  });

  test("falls back to window.__LAST_HYDRATED_*__ and patches sessionStorage", async () => {
    window.__LAST_HYDRATED_TOKEN__ = "mem-tok";
    window.__LAST_HYDRATED_EMAIL__ = "mem@b.ph";
    const res = await ensureSessionHydrated();
    expect(res.hydrated).toBe(true);
    expect(res.token).toBe("mem-tok");
    expect(res.email).toBe("mem@b.ph");
    // The patch: downstream readers must find sessionStorage populated.
    expect(sessionStorage.getItem("branchAdminToken")).toBe("mem-tok");
    expect(sessionStorage.getItem("branchEmail")).toBe("mem@b.ph");
    expect(sessionStorage.getItem("branchAdminRole")).toBe("branchadmin");
    expect(sessionStorage.getItem("branchId")).toBe("unknown");
    expect(sessionStorage.getItem("branchName")).toBe("unknown");
  }, 10000); // exhausts 30 x 100ms retries before the fallback kicks in

  test("resolves hydrated:false when nothing is available anywhere", async () => {
    const res = await ensureSessionHydrated();
    expect(res).toEqual({
      token: null,
      email: null,
      id: null,
      name: null,
      hydrated: false,
    });
  }, 10000);
});
