// ADM2 — ProtectedRoute: the gate in front of every admin page.
//
// Contracts pinned here:
//   1. Nothing renders (not even a redirect) until AuthContext hydration
//      settles — prevents redirect-flicker logouts on slow tabs.
//   2. Role is derived from which sessionStorage token exists
//      (superAdminToken beats branchAdminToken), and requiredRole mismatches
//      redirect instead of rendering.
//   3. Multi-tab fallback: the tab that owns the socket may rehydrate a
//      session from localStorage fallback values; other tabs may NOT reuse
//      the fallback fake token.

import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ProtectedRoute from "./ProtectedRoute";
import AuthContext from "../context/AuthContext";

const READY = {
  isAuthenticated: true,
  userRole: null,
  isInitialized: true,
  fallbackHydrationComplete: true,
  sessionHydrated: true,
};

function renderGuard({ ctx = READY, requiredRole = null } = {}) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/protected"]}>
        <Routes>
          <Route path="/" element={<div>LOGIN PAGE</div>} />
          <Route
            path="/protected"
            element={
              <ProtectedRoute requiredRole={requiredRole}>
                <div>SECRET CONTENT</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("hydration gating", () => {
  test.each([
    ["isInitialized", { ...READY, isInitialized: false }],
    ["fallbackHydrationComplete", { ...READY, fallbackHydrationComplete: false }],
    ["sessionHydrated", { ...READY, sessionHydrated: false }],
  ])("renders NOTHING while %s is false (no premature redirect)", (_, ctx) => {
    sessionStorage.setItem("superAdminToken", "tok");
    renderGuard({ ctx });
    expect(screen.queryByText("SECRET CONTENT")).not.toBeInTheDocument();
    expect(screen.queryByText("LOGIN PAGE")).not.toBeInTheDocument();
  });
});

describe("token + role checks", () => {
  test("no token at all redirects to login", () => {
    renderGuard();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
  });

  test("superadmin token satisfies requiredRole=superadmin", () => {
    sessionStorage.setItem("superAdminToken", "sa-tok");
    renderGuard({ requiredRole: "superadmin" });
    expect(screen.getByText("SECRET CONTENT")).toBeInTheDocument();
  });

  test("branchadmin token cannot enter a superadmin route", () => {
    sessionStorage.setItem("branchAdminToken", "ba-tok");
    renderGuard({ requiredRole: "superadmin" });
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
  });

  test("superAdminToken outranks branchAdminToken when both exist", () => {
    sessionStorage.setItem("superAdminToken", "sa-tok");
    sessionStorage.setItem("branchAdminToken", "ba-tok");
    renderGuard({ requiredRole: "superadmin" });
    expect(screen.getByText("SECRET CONTENT")).toBeInTheDocument();
  });

  test("no requiredRole: any valid token passes", () => {
    sessionStorage.setItem("branchAdminToken", "ba-tok");
    renderGuard();
    expect(screen.getByText("SECRET CONTENT")).toBeInTheDocument();
  });
});

describe("multi-tab socket-owner fallback", () => {
  test("socket-owning tab rehydrates from localStorage fallback and patches sessionStorage", () => {
    localStorage.setItem("tabId", "tab-A");
    localStorage.setItem("activeSocketTabId", "tab-A");
    localStorage.setItem("fallbackBranchRole", "branchadmin");
    localStorage.setItem("fallbackBranchEmail", "makati@magis.ph");
    localStorage.setItem("fallbackBranchId", "BR-7");
    localStorage.setItem("fallbackBranchName", "Makati");

    renderGuard();
    expect(screen.getByText("SECRET CONTENT")).toBeInTheDocument();
    expect(sessionStorage.getItem("branchAdminToken")).toBe("__FALLBACK_FAKE_TOKEN__");
    expect(sessionStorage.getItem("branchEmail")).toBe("makati@magis.ph");
    expect(sessionStorage.getItem("branchId")).toBe("BR-7");
    expect(sessionStorage.getItem("branchName")).toBe("Makati");
  });

  test("socket owner WITHOUT fallback values redirects", () => {
    localStorage.setItem("tabId", "tab-A");
    localStorage.setItem("activeSocketTabId", "tab-A");
    renderGuard();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
  });

  test("fallback fake token is rejected on a tab that does NOT own the socket", () => {
    sessionStorage.setItem("branchAdminToken", "__FALLBACK_FAKE_TOKEN__");
    localStorage.setItem("tabId", "tab-B");
    localStorage.setItem("activeSocketTabId", "tab-A");
    renderGuard();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
  });

  test("non-owning tab with NO token does not steal the fallback session", () => {
    localStorage.setItem("tabId", "tab-B");
    localStorage.setItem("activeSocketTabId", "tab-A");
    localStorage.setItem("fallbackBranchRole", "branchadmin");
    localStorage.setItem("fallbackBranchEmail", "makati@magis.ph");
    renderGuard();
    expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument();
    expect(sessionStorage.getItem("branchAdminToken")).toBeNull();
  });
});
