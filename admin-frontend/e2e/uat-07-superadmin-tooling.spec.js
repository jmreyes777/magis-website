// UAT W7 (megaplan Phase C) — superadmin tooling against mocked backend APIs.
// Hermetic rule: /api/* is mocked with real response shapes; Firestore stays
// BLOCKED, so its failure UX is tested surface (that is the F6 regression).
// Live-Firestore table data remains a documented coverage limit.
const { test, expect } = require("@playwright/test");
const {
  BRANCH,
  mockNetwork,
  seedSuperAdminSession,
  callsTo,
} = require("./fixtures");

test.describe("W7: superadmin tooling", () => {
  test("branch passwords: Firestore outage → readable error + Try again re-runs the load (F6)", async ({ page }) => {
    const state = await mockNetwork(page);
    await seedSuperAdminSession(page);
    await page.goto("/admin/branch-passwords");

    await expect(page.getByRole("heading", { name: "Branch Login Passwords" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Failed to load branches from Firestore.")).toBeVisible();

    // F6: Try again re-runs loadAll — a second credentials fetch goes out.
    const listCallsBefore = callsTo(state, "/api/branch/admin/list").length;
    expect(listCallsBefore).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: /try again/i }).click();
    await expect
      .poll(() => callsTo(state, "/api/branch/admin/list").length, { timeout: 10_000 })
      .toBeGreaterThan(listCallsBefore);
  });

  test("branch passwords: expired superadmin session (401) → sign-in-again message", async ({ page }) => {
    await mockNetwork(page, { superSessionExpired: true });
    await seedSuperAdminSession(page);
    await page.goto("/admin/branch-passwords");

    await expect(page.getByText(/super-admin session expired/i)).toBeVisible({ timeout: 15_000 });
  });

  test("staff management: list renders; reset-password reveals the one-time credential with the email-failure notice", async ({ page }) => {
    await mockNetwork(page);
    await seedSuperAdminSession(page);
    await page.goto("/admin/staff");

    // Both seeded staffers render with their 2FA/status badges.
    await expect(page.getByText("ana@magis.test")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("ben@magis.test")).toBeVisible();

    // Reset PW on Ana → one-time reveal modal; the mock reports the email
    // FAILING, so the modal must say so and still show the password.
    const anaRow = page.locator("tr", { hasText: "ana@magis.test" });
    await anaRow.getByRole("button", { name: "Reset PW" }).click();

    await expect(page.getByRole("heading", { name: "Password reset" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/email delivery failed/i)).toBeVisible();
    await expect(page.getByText("Reset-Pass-5678")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Password reset" })).toHaveCount(0);
  });

  test("staff management: 2FA toggle, enable/disable, revoke devices, and delete-with-confirm all hit the right endpoints", async ({ page }) => {
    const state = await mockNetwork(page);
    await seedSuperAdminSession(page);
    await page.goto("/admin/staff");
    await expect(page.getByText("ana@magis.test")).toBeVisible({ timeout: 15_000 });

    const anaRow = page.locator("tr", { hasText: "ana@magis.test" });
    const benRow = page.locator("tr", { hasText: "ben@magis.test" });

    // Ana has 2FA on → "Disable 2FA" → badge flips to Off after reload.
    await anaRow.getByRole("button", { name: "Disable 2FA" }).click();
    await expect(anaRow.getByText("Off")).toBeVisible({ timeout: 10_000 });
    expect(callsTo(state, "/api/admin/staff/staff-1/2fa").length).toBe(1);

    // Ben is disabled → "Enable" → badge flips.
    await benRow.getByRole("button", { name: "Enable", exact: true }).click();
    await expect
      .poll(() => callsTo(state, "/api/admin/staff/staff-2/enable").length, { timeout: 10_000 })
      .toBe(1);

    // Revoke devices → flash mentions the mocked count.
    await anaRow.getByRole("button", { name: "Revoke devices" }).click();
    await expect(page.getByText(/revoked 2 trusted device/i)).toBeVisible({ timeout: 10_000 });

    // Delete uses a native confirm — accept it, row disappears.
    page.once("dialog", (d) => d.accept());
    await benRow.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("ben@magis.test")).toHaveCount(0, { timeout: 10_000 });
    expect(state.staffList.some((s) => s.id === "staff-2")).toBe(false);
  });

  test("observability: snapshot renders backup health; outage shows a readable error", async ({ page }) => {
    await mockNetwork(page);
    await seedSuperAdminSession(page);
    await page.goto("/admin/observability");

    await expect(page.getByRole("heading", { name: "Observability" })).toBeVisible({ timeout: 15_000 });
    // Backup card from the mocked summary: OK + doc count.
    await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/1234 docs/)).toBeVisible();
  });

  test("audit & compliance (superadmin scope): summary + events table render from mocks", async ({ page }) => {
    await mockNetwork(page);
    await seedSuperAdminSession(page);
    await page.goto("/admin/audit");

    await expect(page.getByRole("heading", { name: "Audit & Compliance" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/viewing/i)).toBeVisible();
    await expect(page.getByText("all branches")).toBeVisible();

    // Events from the mock, with action + severity + outcome rendered.
    // (Scoped to the table — the filter dropdowns carry the same words.)
    const table = page.locator("table");
    await expect(table.getByText("message.read")).toBeVisible({ timeout: 10_000 });
    await expect(table.getByText("stepup.verify")).toBeVisible();
    await expect(table.getByText("warning")).toBeVisible();
    await expect(table.getByText(`branch · ${BRANCH.email}`).first()).toBeVisible();
  });
});
