// UAT G6 (megaplan Phase D) — keyboard-only + accessible-name sweep of the
// guest critical path. A keyboard user must be able to run the entire support
// conversation: open → type → Enter-to-send (F-G14) → close via the confirm
// dialog (focus lands inside, Escape backs out). Icon-only controls must
// carry accessible names (the F-G5/F-G8 pattern, generalized).
const { test, expect } = require("@playwright/test");
const {
  mockGuestNetwork,
  fakeSocketIO,
  openSupportChat,
  waitForSocketReady,
} = require("./uat-fixtures");

test.describe("G6: keyboard & accessible-name a11y", () => {
  test("keyboard-only chat: Enter sends; close flows through the accessible confirm dialog", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await waitForSocketReady(state, expect);

    // Type and send with ENTER only (F-G14 regression trap).
    const composer = page.getByPlaceholder("Chat branch");
    await composer.focus();
    await composer.pressSequentially("Is my ring ready?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Is my ring ready?")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => state.socketEmits.filter((e) => e.event === "sendMessage").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // Close via keyboard: the dialog opens with focus ON the confirm action.
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const focusedText = await page.evaluate(() => document.activeElement?.textContent || "");
    expect(focusedText).toMatch(/end chat|close|switch/i);

    // Escape cancels — conversation survives.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".guest-chat-box")).toBeVisible();

    // Reopen and confirm with Enter (focus is already on the confirm button).
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator(".guest-chat-box")).toHaveCount(0, { timeout: 10_000 });
  });

  test("every button in the chat surface has an accessible name", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);

    const nameless = await page.evaluate(() => {
      const accName = (el) =>
        (el.getAttribute("aria-label") ||
          el.textContent?.trim() ||
          el.getAttribute("title") ||
          "").trim();
      return [...document.querySelectorAll(".guest-chat-box button")]
        .filter((b) => !accName(b))
        .map((b) => b.outerHTML.slice(0, 80));
    });
    expect(nameless).toEqual([]);
  });
});
