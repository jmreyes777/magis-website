// UAT G3 — the surrounding guest UX: contact form, privacy notice, transcript
// ("Contact Branch") modal, and ending a chat. Multi-step interactions that
// cross component boundaries, plus the friction probes noted in UAT-REPORT.md.
const { test, expect } = require("@playwright/test");
const {
  mockGuestNetwork,
  fakeSocketIO,
  openSupportChat,
  waitForHydration,
  waitForSocketReady,
  callsTo,
} = require("./uat-fixtures");

test.describe.configure({ timeout: 60_000 });

test.describe("G3: guest pages & chat lifecycle", () => {
  test("contact form: submit succeeds (via blocking alert) and clears the form", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await page.goto("/contact-us");
    await waitForHydration(page, "form input#name");

    await page.getByLabel("Name").fill("Juan dela Cruz");
    await page.getByLabel("Email").fill("juan@example.com");
    await page.getByLabel("Message").fill("Do you accept 18k gold?");

    // FRICTION (report F-G4): success feedback is a blocking window.alert().
    const dialogPromise = page.waitForEvent("dialog");
    await page.getByRole("button", { name: /send message/i }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/thank you for reaching out/i);
    await dialog.accept();

    await expect
      .poll(() => callsTo(state, "/api/contact").length, { timeout: 15_000 })
      .toBe(1);
    expect(callsTo(state, "/api/contact")[0].postData.message).toBe("Do you accept 18k gold?");
    await expect(page.getByLabel("Name")).toHaveValue(""); // cleared on success
  });

  test("privacy notice: visible zero-click, links to policy, minimizes and restores", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);

    // Zero-click consent notice with a working policy link.
    const notice = page.locator(".guest-chat-box").getByText(/privacy policy/i).first();
    await expect(notice).toBeVisible();
    await expect(page.locator(".guest-chat-box a[href='/privacy-policy']")).toHaveCount(1);

    // Minimize → compact pill; restore → full text again. Both toggles are
    // bare <span>s, not buttons — keyboard users can't reach them (report
    // F-G8) — so these locators must target text/title instead of roles.
    await page.locator(".guest-chat-box span[title='Hide']").click();
    await expect(page.locator(".guest-chat-box a[href='/privacy-policy']")).toHaveCount(0);
    await page.locator(".guest-chat-box").getByText("Privacy Policy", { exact: true }).click();
    await expect(page.locator(".guest-chat-box a[href='/privacy-policy']")).toHaveCount(1);
  });

  test("transcript button opens the Contact Branch modal (copy mismatch noted)", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);

    // FRICTION (report F-G5): tooltip promises a downloadable transcript, but
    // the modal is a direct-message form titled "Contact Branch".
    await page.locator("button[title='Download and send chat transcript to branch']").click();
    await expect(page.getByRole("heading", { name: /contact branch/i })).toBeVisible();
    await page.locator(".modal-close-btn").click(); // modal-scoped: the chat header has its own Close
    await expect(page.getByRole("heading", { name: /contact branch/i })).toHaveCount(0);
  });

  test("closing the chat asks for confirmation and force-closes the session", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    // Send one message so the confirm actually has something to protect.
    await page.getByPlaceholder("Chat branch").fill("closing soon");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 })
      .toBe(1);

    // FRICTION (report F-G4): confirmation is a native window.confirm.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await expect(page.locator(".guest-chat-box")).toHaveCount(0, { timeout: 15_000 });
    // The X-close path tells the branch over the socket (chatClosed); the
    // REST force-close is reserved for unload beacons and branch switching.
    await expect
      .poll(
        () =>
          state.socketEmits.filter((e) => e.event === "chatClosed").length +
          callsTo(state, "/api/guest/force-close").length,
        { timeout: 15_000 }
      )
      .toBeGreaterThanOrEqual(1);

    // Session artifacts cleared — a reload must NOT resurrect the chat.
    const chatOpen = await page.evaluate(() => sessionStorage.getItem("chatOpen"));
    expect(chatOpen).not.toBe("true");
  });
});
