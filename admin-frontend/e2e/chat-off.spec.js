// CHAT-PARK — the parked-build contract for the admin console: the Chat
// Dashboard is hidden, branch/staff logins land on Activity History instead,
// /admin/chats redirects, and the chat-only header widgets stay off. Runs only
// against the default (chat OFF) build — playwright.config.js ignores it when
// REACT_APP_CHAT_ENABLED=true.
const { test, expect } = require("@playwright/test");
const { BRANCH, OTP_GOOD, mockNetwork, seedBranchSession } = require("./fixtures");

const PASSWORD = "correct-horse-battery";

test.describe("CHAT-PARK: parked admin console", () => {
  test("login happy path lands on Activity History, never the chat dashboard", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/branch-admin-login");
    await page.getByPlaceholder("Email").fill(BRANCH.email);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.getByPlaceholder("••••••").fill(OTP_GOOD);
    await page.waitForURL("**/admin/audit", { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /activity history/i })).toBeVisible();
    expect(page.url()).not.toContain("/admin/chats");
  });

  test("/admin/chats redirects a logged-in branch admin to Activity History", async ({ page }) => {
    await mockNetwork(page);
    await seedBranchSession(page);
    await page.goto("/admin/chats");
    await page.waitForURL("**/admin/audit", { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /branch chat dashboard/i })).toHaveCount(0);
  });

  test("branch-admin chrome: Analytics nav replaces Chat Dashboard, chat widgets hidden", async ({ page }) => {
    await mockNetwork(page);
    await seedBranchSession(page);
    await page.goto("/admin/audit");

    // Parked notice explains the missing dashboard.
    await expect(page.getByText(/live chat is paused/i)).toBeVisible();

    // Nav: no Chat Dashboard; Analytics is the new entry point.
    await expect(page.getByRole("button", { name: "Chat Dashboard" })).toHaveCount(0);
    await page.getByRole("button", { name: "Analytics" }).click();
    await page.waitForURL("**/admin/analytics", { timeout: 15_000 });

    // Chat-only header widgets stay off (waiting-guests chip).
    await page.goto("/admin/audit");
    await expect(page.locator(".waiting-chip")).toHaveCount(0);
  });
});
