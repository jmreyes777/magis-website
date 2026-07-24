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
  test("contact form: submit shows inline success (no blocking alert) and clears the form", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await page.goto("/contact-us");
    await waitForHydration(page, "form input#name");

    await page.getByLabel("Name").fill("Juan dela Cruz");
    await page.getByLabel("Email").fill("juan@example.com");
    await page.getByLabel("Message").fill("Do you accept 18k gold?");

    // F-G4 (fixed): success is an inline, non-blocking status banner.
    let sawDialog = false;
    page.on("dialog", (d) => {
      sawDialog = true;
      d.dismiss().catch(() => {});
    });
    await page.getByRole("button", { name: /send message/i }).click();

    await expect(page.getByText(/thank you for reaching out/i)).toBeVisible({ timeout: 15_000 });
    expect(sawDialog).toBe(false); // regression trap: no window.alert

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

    // F-G8 (fixed): both toggles are real, keyboard-reachable buttons now.
    await page.getByRole("button", { name: "Hide privacy notice" }).click();
    await expect(page.locator(".guest-chat-box a[href='/privacy-policy']")).toHaveCount(0);
    await page.getByRole("button", { name: "Show privacy notice" }).click();
    await expect(page.locator(".guest-chat-box a[href='/privacy-policy']")).toHaveCount(1);
  });

  test("contact-branch button opens the matching modal (F-G5 copy aligned)", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);

    // F-G5 (fixed): the tooltip now says what the modal actually is.
    await page.getByRole("button", { name: "Contact branch" }).click();
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

    // F-G4 (fixed): closing asks via the in-app dialog, not window.confirm.
    let sawDialog = false;
    page.on("dialog", (d) => {
      sawDialog = true;
      d.dismiss().catch(() => {});
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /end this chat/i })).toBeVisible();

    // Cancel keeps the conversation.
    await page.getByRole("button", { name: /keep chatting/i }).click();
    await expect(page.locator(".guest-chat-box")).toBeVisible();

    // Confirm ends it.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: /end chat/i }).click();
    expect(sawDialog).toBe(false); // regression trap: no native confirm

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
