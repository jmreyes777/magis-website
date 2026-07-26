// UAT W9 (megaplan Phase D) — keyboard-only + accessible-name sweep of the
// staff critical path: login by keyboard, reply with Enter-to-send (F13),
// and no nameless icon buttons on the dashboard.
const { test, expect } = require("@playwright/test");
const {
  GUEST,
  mockNetwork,
  seedBranchSession,
  guestMessage,
  waitForAdminSocket,
  emitsOf,
} = require("./fixtures");

test.describe("W9: keyboard & accessible-name a11y", () => {
  test("login form is fully keyboard-operable (Tab order, Enter submits)", async ({ page }) => {
    await mockNetwork(page);
    await page.goto("/branch-admin-login");

    const email = page.getByPlaceholder(/email/i).first();
    await email.click();
    await email.pressSequentially("branch1@magis.test");
    await page.keyboard.press("Tab");

    // Password lands next in tab order — type + Enter submits the form.
    await page.keyboard.type("wrong-password");
    await page.keyboard.press("Enter");

    // The submit fired: a readable failure surfaces (the 401 falls through to
    // the blocked Firebase flow, so the F1 bounded-outage copy also counts —
    // same contract as uat-01). Form stays usable either way.
    await expect(
      page.getByText(/invalid email or password|authentication service unavailable|login failed/i)
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder(/email/i).first()).toHaveValue("branch1@magis.test");
  });

  test("keyboard-only reply: Enter sends from the composer (F13)", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await seedBranchSession(page);
    await page.goto("/admin/chats");
    await waitForAdminSocket(state, expect);

    state.pushEvent("receiveMessage", guestMessage());
    await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });

    const composer = page.getByPlaceholder("Type your reply…");
    await composer.focus();
    await composer.pressSequentially("Ready after 2 PM.");
    await page.keyboard.press("Enter");

    await expect(page.locator(".chat-messages").getByText("Ready after 2 PM.")).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(() => emitsOf(state, "sendMessage").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("every button on the chat dashboard has an accessible name", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await seedBranchSession(page);
    await page.goto("/admin/chats");
    await waitForAdminSocket(state, expect);
    state.pushEvent("receiveMessage", guestMessage());
    await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });

    const nameless = await page.evaluate(() => {
      const accName = (el) =>
        (el.getAttribute("aria-label") ||
          el.textContent?.trim() ||
          el.getAttribute("title") ||
          "").trim();
      return [...document.querySelectorAll("button")]
        .filter((b) => !accName(b))
        .map((b) => b.outerHTML.slice(0, 80));
    });
    expect(nameless).toEqual([]);
  });
});
