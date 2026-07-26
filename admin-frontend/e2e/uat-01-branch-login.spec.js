// UAT W1 — the phone-less branch login journey (password → emailed code →
// dashboard), plus exploratory probes around every way the happy path can go
// wrong. Validates the multi-page flow end-to-end in the production bundle:
// credentials view → OTP view → (optional forced password change) → /admin/chats.
const { test, expect } = require("@playwright/test");
const { BRANCH, OTP_GOOD, OTP_BAD, mockNetwork, callsTo } = require("./fixtures");

const PASSWORD = "correct-horse-battery";

async function fillCredentials(page, password = PASSWORD) {
  await page.goto("/branch-admin-login");
  await page.getByPlaceholder("Email").fill(BRANCH.email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

test.describe("W1: unified branch login (email-OTP path)", () => {
  test("happy path: password → emailed code auto-submits → chat dashboard", async ({ page }) => {
    const state = await mockNetwork(page);
    await fillCredentials(page);

    // OTP step announces where the code went (UX: user knows which inbox).
    await expect(page.getByText(new RegExp(`emailed a 6-digit code to ${BRANCH.email}`, "i"))).toBeVisible();

    // Typing the 6th digit auto-submits — no extra click needed.
    await page.getByPlaceholder("••••••").fill(OTP_GOOD);
    await page.waitForURL("**/admin/chats", { timeout: 15_000 });

    // The login must have used the branch email-OTP endpoints only — never
    // Firebase (which would demand a QR/authenticator this branch cannot use).
    expect(callsTo(state, "/api/branch/login").length).toBeGreaterThanOrEqual(2);
    expect(callsTo(state, "/api/staff/login").length).toBe(0);
  });

  test("wrong password: generic error (anti-enumeration), form stays usable", async ({ page }) => {
    await mockNetwork(page);
    await fillCredentials(page, "wrong-password");

    // The 401 falls through to the Firebase flow, which is blocked in UAT —
    // the user must still end up with a readable error, not a dead spinner.
    await expect(page.getByText(/invalid email or password|authentication service unavailable|login failed/i))
      .toBeVisible({ timeout: 10_000 });
    // Still on the credentials form, able to retry.
    await expect(page.getByPlaceholder("Password")).toBeVisible();
  });

  test("wrong OTP: error + form clears for retry; correct code then succeeds", async ({ page }) => {
    await mockNetwork(page);
    await fillCredentials(page);

    const otpBox = page.getByPlaceholder("••••••");
    await otpBox.fill(OTP_BAD);
    // UAT F4: the error must include how many tries remain (mock says 4).
    await expect(page.getByText(/incorrect code.*4 attempts left/i)).toBeVisible();
    await expect(otpBox).toHaveValue(""); // cleared for immediate retry

    await otpBox.fill(OTP_GOOD);
    await page.waitForURL("**/admin/chats");
  });

  test("resend cooldown: button disabled with countdown after OTP is sent", async ({ page }) => {
    await mockNetwork(page);
    await fillCredentials(page);

    const resend = page.getByRole("button", { name: /resend code/i });
    await expect(resend).toBeVisible();
    await expect(resend).toBeDisabled();
    await expect(resend).toContainText(/resend code in \d+s/i);
  });

  test("rate-limited login: 429 shows a wait message, not a crash", async ({ page }) => {
    await mockNetwork(page, { loginRateLimited: true });
    await fillCredentials(page);
    await expect(page.getByText(/too many attempts/i)).toBeVisible();
  });

  test("remember email: opt-in prefills the email on return — and NEVER stores the password", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/branch-admin-login");
    await page.getByPlaceholder("Email").fill(BRANCH.email);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.getByText("Remember email on this device").click();
    await expect(page.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.getByPlaceholder("••••••").fill(OTP_GOOD);
    await page.waitForURL("**/admin/chats", { timeout: 15_000 });

    // Back at the login page: email prefilled, checkbox remembered, password EMPTY.
    await page.goto("/branch-admin-login");
    await expect(page.getByPlaceholder("Email")).toHaveValue(BRANCH.email);
    await expect(page.getByRole("checkbox")).toBeChecked();
    await expect(page.getByPlaceholder("Password")).toHaveValue("");

    // F3 trap: nothing password-like may live in storage — email only.
    const stored = await page.evaluate(() => ({
      remembered: localStorage.getItem("rememberedBranchEmail"),
      valuesWithPassword: Object.keys(localStorage)
        .map((k) => localStorage.getItem(k) || "")
        .filter((v) => v.includes("correct-horse-battery")).length,
    }));
    expect(stored.remembered).toBe(BRANCH.email);
    expect(stored.valuesWithPassword).toBe(0);

    // Unchecking forgets immediately.
    await page.getByRole("checkbox").uncheck();
    expect(await page.evaluate(() => localStorage.getItem("rememberedBranchEmail"))).toBeNull();
  });

  test("disabled account: 403 surfaces the admin-contact message", async ({ page }) => {
    await mockNetwork(page);
    await fillCredentials(page, "disabled-account");
    await expect(page.getByText(/account has been disabled/i)).toBeVisible();
  });

  test("forced password change: intercepts before dashboard, skippable copy shown", async ({ page }) => {
    await mockNetwork(page, { mustChangePassword: true });
    await fillCredentials(page);
    await page.getByPlaceholder("••••••").fill(OTP_GOOD);

    // Change-password interstitial appears INSTEAD of the dashboard.
    await expect(page.getByText(/set your own password now/i)).toBeVisible();
    expect(page.url()).not.toContain("/admin/chats");

    await page.getByPlaceholder(/new password/i).first().fill("a-new-long-password");
    await page.getByPlaceholder(/confirm new password/i).fill("a-new-long-password");
    await page.getByRole("button", { name: /set password/i }).click();
    await page.waitForURL("**/admin/chats");
  });

  test("forgot password: request → reset view with neutral confirmation", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/branch-admin-login");
    await page.getByPlaceholder("Email").fill(BRANCH.email);
    await page.getByRole("button", { name: /forgot password/i }).click();

    // Neutral anti-enumeration copy: "If <email> is a branch account..."
    await page.getByRole("button", { name: /send reset code/i }).click();
    await expect(page.getByText(/if .* is a branch account/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder("6-digit reset code")).toBeVisible();
  });
});
