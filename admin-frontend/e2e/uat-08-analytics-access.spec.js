// UAT W8 (megaplan Phase C) — analytics (branch-admin view), the landing
// portal, the superadmin login's hermetic surfaces, and the ROLE matrix
// extension across the Phase C routes (superadmin ↔ branchadmin must never
// see each other's tools).
const { test, expect } = require("@playwright/test");
const {
  mockNetwork,
  seedBranchSession,
  seedSuperAdminSession,
} = require("./fixtures");

test.describe("W8: analytics, landing, login surfaces, role matrix", () => {
  test("analytics (branch admin): mocked metrics render into the operational cards", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    await seedBranchSession(page);
    await page.goto("/admin/analytics");

    await expect(page.getByRole("heading", { name: "Branch Analytics Dashboard" })).toBeVisible({
      timeout: 15_000,
    });
    // Cards fed by the mocked endpoints.
    await expect(page.getByText("Total Messages")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("342", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/avg 11 messages\/day/i)).toBeVisible();
    await expect(page.getByText("Total Conversations")).toBeVisible();
    await expect(page.getByText("58", { exact: true }).first()).toBeVisible();
  });

  test("analytics: backend outage → readable failure, page stays navigable", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true, analyticsFails: true });
    await seedBranchSession(page);
    await page.goto("/admin/analytics");

    await expect(page.getByRole("heading", { name: "Branch Analytics Dashboard" })).toBeVisible({
      timeout: 15_000,
    });
    // Zeroed cards, no crash — the page's degraded state is honest defaults.
    await expect(page.getByText("Total Messages")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /logout/i })).toBeVisible();
  });

  test("landing portal renders the admin entry point", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /welcome to the magis admin portal/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("superadmin login: client-side domain validation + graceful failure when the auth service is down", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/super-admin-login");
    await expect(page.getByRole("heading", { name: "Super Admin Login" })).toBeVisible({ timeout: 15_000 });

    // Wrong domain rejected before any network call.
    await page.getByPlaceholder(/email/i).fill("intruder@evil.com");
    await page.getByPlaceholder(/password/i).fill("whatever-long-pass");
    await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();
    await expect(page.getByText(/valid @magisgold\.com/i)).toBeVisible();

    // Right domain but Firebase auth is blocked (outage) → readable error,
    // form stays usable — never a silent spinner.
    await page.getByPlaceholder(/email/i).fill("admin@magisgold.com");
    await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();
    await expect(page.locator(".text-red-600, .text-red-500, [role=alert]").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("role matrix: superadmin cannot enter branch-admin tools; branch admin cannot enter superadmin tools", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    await seedSuperAdminSession(page);

    // Superadmin blocked from branchadmin-only analytics → bounced to landing.
    await page.goto("/admin/analytics");
    await expect(page.getByRole("heading", { name: /welcome to the magis admin portal/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Branch Analytics Dashboard")).toHaveCount(0);

    // …and superadmin-only staff tools DO open.
    await page.goto("/admin/staff");
    await expect(page.getByText("ana@magis.test")).toBeVisible({ timeout: 15_000 });
  });

  test("role matrix: branch admin bounced from staff management and observability (no content leak)", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    await seedBranchSession(page);

    await page.goto("/admin/staff");
    await expect(page.getByRole("heading", { name: /welcome to the magis admin portal/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("ana@magis.test")).toHaveCount(0);

    await page.goto("/admin/observability");
    await expect(page.getByRole("heading", { name: /welcome to the magis admin portal/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: "Observability" })).toHaveCount(0);
  });

  test("audit as branch admin: scoped 'Activity History' view, not the compliance console", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    await seedBranchSession(page);
    await page.goto("/admin/audit");

    await expect(page.getByRole("heading", { name: "Activity History" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Audit & Compliance" })).toHaveCount(0);
    // Scope banner names the branch, and the mocked events render.
    await expect(page.getByText(/activity history for/i)).toBeVisible();
    await expect(page.getByText("message.read")).toBeVisible({ timeout: 10_000 });
  });
});
