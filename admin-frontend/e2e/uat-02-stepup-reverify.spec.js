// UAT W2 — the 8-hour re-verification gate for a branch email-OTP account
// inside the chat dashboard. This is the exact scenario that used to dead-end:
// the modal demanded password + authenticator code from an account that has no
// authenticator. Now it must (a) show the EMAIL-code form, (b) auto-request a
// code, (c) verify via /api/branch/stepup/* — never /api/staff/stepup/* — and
// (d) resume the dashboard on success / log out on cancel.
const { test, expect } = require("@playwright/test");
const { OTP_GOOD, OTP_BAD, mockNetwork, seedBranchSession, callsTo } = require("./fixtures");

test.describe("W2: MFA step-up re-verification (branch email-OTP)", () => {
  test("expired session → email-code modal → verify → dashboard resumes", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: false });
    await seedBranchSession(page);
    await page.goto("/admin/chats");

    // The security modal appears (session not verified).
    await expect(page.getByText(/security verification/i)).toBeVisible({ timeout: 15_000 });

    // CORE ASSERTION: email-code UI, NOT the password+authenticator form.
    await expect(page.getByText(/enter the 6-digit code we emailed you/i)).toBeVisible();
    await expect(page.getByPlaceholder(/enter your password/i)).toHaveCount(0);
    await expect(page.getByText(/authenticator code/i)).toHaveCount(0);

    // A code was auto-requested from the BRANCH step-up endpoint.
    await expect
      .poll(() => callsTo(state, "/api/branch/stepup/request").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    expect(callsTo(state, "/api/staff/stepup").length).toBe(0); // regression trap

    // Verify with the emailed code → modal closes, dashboard usable again.
    await page.getByPlaceholder("6-digit code").fill(OTP_GOOD);
    await page.getByRole("button", { name: /verify & continue/i }).click();
    await expect(page.getByText(/security verification/i)).toHaveCount(0, { timeout: 10_000 });
    expect(callsTo(state, "/api/branch/stepup/verify").length).toBeGreaterThanOrEqual(1);
    expect(callsTo(state, "/api/staff/stepup").length).toBe(0);
    expect(page.url()).toContain("/admin/chats"); // never bounced to login
  });

  test("wrong code: readable error, input survives for retry", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: false });
    await seedBranchSession(page);
    await page.goto("/admin/chats");

    await expect(page.getByText(/security verification/i)).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("6-digit code").fill(OTP_BAD);
    await page.getByRole("button", { name: /verify & continue/i }).click();
    await expect(page.getByText(/incorrect code/i)).toBeVisible();

    // Recovery: correct code still works after the failure.
    await page.getByPlaceholder("6-digit code").fill(OTP_GOOD);
    await page.getByRole("button", { name: /verify & continue/i }).click();
    await expect(page.getByText(/security verification/i)).toHaveCount(0, { timeout: 10_000 });
  });

  test("rate-limited code request: modal shows wait message with retry countdown", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: false, stepupRequestFails: true });
    await seedBranchSession(page);
    await page.goto("/admin/chats");

    await expect(page.getByText(/security verification/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/please wait before requesting another code/i)).toBeVisible();
    // Resend honors the server's retryAfterSec (60s), not a dead button.
    await expect(page.getByRole("button", { name: /resend code in \d+s/i })).toBeVisible();
  });

  test("cancel logs out to the login page (no half-authenticated state)", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: false });
    await seedBranchSession(page);
    await page.goto("/admin/chats");

    await expect(page.getByText(/security verification/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await page.waitForURL(/branch-admin-login/, { timeout: 15_000 });

    // Session artifacts wiped: reloading a protected page must not re-enter.
    await page.goto("/admin/chats");
    await expect(page).not.toHaveURL(/admin\/chats/, { timeout: 10_000 });
  });

  test("already-verified session: no modal friction at all", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    await seedBranchSession(page);
    await page.goto("/admin/chats");

    // Give the gate a moment to run, then confirm it stayed silent.
    await page.waitForTimeout(4000);
    await expect(page.getByText(/enter the 6-digit code we emailed you/i)).toHaveCount(0);
    expect(page.url()).toContain("/admin/chats");
  });
});
