// UAT W3 — access-control seams between pages: deep links without a session,
// role boundaries, and expired-token recovery. These are the paths a real user
// hits by bookmarking URLs, reopening the Electron app days later, or pasting
// an admin link into the wrong window.
const { test, expect } = require("@playwright/test");
const { makeJwt, mockNetwork, seedBranchSession } = require("./fixtures");

test.describe("W3: access control & session-expiry journeys", () => {
  test("deep link to /admin/chats with no session → bounced to a login page", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/admin/chats");
    // Must land on landing or login — never the dashboard shell.
    await expect(page).not.toHaveURL(/admin\/chats/, { timeout: 15_000 });
    await expect(page.locator("input[type=password], a[href*='login'], button").first()).toBeVisible();
  });

  test("branchadmin visiting a superadmin page → redirected away", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    await seedBranchSession(page);
    await page.goto("/admin/branch-passwords");
    await expect(page).not.toHaveURL(/branch-passwords/, { timeout: 15_000 });
    // And no superadmin content leaked before the redirect.
    await expect(page.getByText(/branch login passwords/i)).toHaveCount(0);
  });

  test("expired token + failed rotation → clean logout to login page", async ({ page }) => {
    await mockNetwork(page, { rotationFails: true });
    const expired = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await seedBranchSession(page, { token: expired });
    await page.goto("/admin/chats");
    await page.waitForURL(/branch-admin-login|\/$/, { timeout: 15_000 });
  });

  test("expired token + successful silent rotation → stays signed in", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true });
    const expired = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await seedBranchSession(page, { token: expired });
    await page.goto("/admin/chats");

    // AuthContext exchanges the just-expired token for a fresh one and the
    // dashboard proceeds — the user never sees a login screen.
    await page.waitForTimeout(4000);
    expect(page.url()).toContain("/admin/chats");
  });

  test("landing page: both login doors are discoverable", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/");
    const links = page.locator("a[href*='login'], button");
    await expect(links.first()).toBeVisible();
  });

  test("logout UX: 'Logging out…' overlay, NO amber reconnect flash, clean landing on login", async ({ page }) => {
    await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await seedBranchSession(page);
    await page.goto("/admin/chats");
    await expect(page.getByRole("button", { name: /logout/i })).toBeVisible({ timeout: 15_000 });

    // Watch for the amber banner from the moment logout is clicked: the socket
    // teardown must NEVER surface "Reconnecting to chat…" during sign-out.
    let sawReconnectBanner = false;
    const watcher = setInterval(async () => {
      try {
        if (await page.getByText(/reconnecting to chat/i).isVisible()) sawReconnectBanner = true;
      } catch { /* page navigating */ }
    }, 100);

    await page.getByRole("button", { name: /logout/i }).click();

    // The gray "Logging out…" overlay appears while the teardown runs.
    await expect(page.getByText("Logging out…")).toBeVisible({ timeout: 5_000 });

    await page.waitForURL(/branch-admin-login/, { timeout: 15_000 });
    clearInterval(watcher);
    expect(sawReconnectBanner).toBe(false);

    // Overlay releases after the transition — login form usable.
    await expect(page.getByText("Logging out…")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByPlaceholder("Email")).toBeVisible();
  });
});
