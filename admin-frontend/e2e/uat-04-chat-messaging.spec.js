// UAT W4 — Branch Chat Dashboard: messaging core, from the staff seat.
// The fake socket server plays the GUEST/backend side: it pushes
// receiveMessage / typing events and records everything the dashboard emits
// (joinRoom, markRead, typing, sendMessage). REST mocks answer the reply +
// MFA endpoints. Firestore stays blocked — live socket traffic must be enough
// to run a conversation (that is the dashboard's documented degraded mode).
const { test, expect } = require("@playwright/test");
const {
  BRANCH,
  GUEST,
  mockNetwork,
  seedBranchSession,
  callsTo,
  emitsOf,
  guestMessage,
  waitForAdminSocket,
  decryptWithKey,
} = require("./fixtures");

async function openDashboard(page, state) {
  await seedBranchSession(page);
  await page.goto("/admin/chats");
  await waitForAdminSocket(state, expect);
}

test.describe("W4: chat dashboard messaging core", () => {
  test("incoming guest message: conversation appears, auto-opens, and is marked read", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openDashboard(page, state);

    state.pushEvent("receiveMessage", guestMessage({ content: "Is my ring ready for pickup?" }));

    // Sidebar row: guest name + preview text.
    await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Is my ring ready for pickup?").first()).toBeVisible();

    // Nothing was selected → the chat auto-opens and the thread shows the message.
    await expect(page.locator(".chat-messages .message-item")).toHaveCount(1);

    // The dashboard told the server the messages are read.
    await expect
      .poll(() => emitsOf(state, "markRead").some((e) => e.args[0]?.guestId === GUEST.id), {
        timeout: 10_000,
      })
      .toBe(true);
  });

  test("second conversation shows an unread badge; selecting it clears the badge and emits markRead", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openDashboard(page, state);

    state.pushEvent("receiveMessage", guestMessage({ content: "First guest here" }));
    await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });

    // A different guest writes while Maria's thread is open → unread badge "1".
    state.pushEvent(
      "receiveMessage",
      guestMessage({ id: "gm-ben-1", guestId: "guest-e2e-88", guestName: "Ben", content: "Hi, do you buy gold coins?" })
    );
    const benRow = page.locator("div.cursor-pointer", { hasText: "Ben" }).first();
    await expect(benRow).toBeVisible();
    await expect(benRow.locator(".bg-red-500")).toHaveText("1");

    // Selecting Ben clears the badge and notifies the server.
    await benRow.click();
    await expect(benRow.locator(".bg-red-500")).toHaveCount(0);
    await expect
      .poll(() => emitsOf(state, "markRead").some((e) => e.args[0]?.guestId === "guest-e2e-88"), {
        timeout: 10_000,
      })
      .toBe(true);

    // Live follow-up from Ben renders in the now-open thread (history itself
    // is Firestore-backed and stays empty hermetically — documented limit).
    state.pushEvent(
      "receiveMessage",
      guestMessage({ id: "gm-ben-2", guestId: "guest-e2e-88", guestName: "Ben", content: "Around 5 grams." })
    );
    await expect(page.locator(".chat-messages").getByText("Around 5 grams.")).toBeVisible();
  });

  test("reply: optimistic bubble → REST persist → WS emit to the guest room → delivered", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openDashboard(page, state);

    state.pushEvent("receiveMessage", guestMessage());
    await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });

    const composer = page.getByPlaceholder("Type your reply…");
    await composer.fill("Yes — ready after 2 PM today.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The reply renders (optimistic → confirmed swap keeps the same text).
    await expect(page.getByText("Yes — ready after 2 PM today.")).toBeVisible();

    // REST persisted it…
    await expect
      .poll(() => callsTo(state, "/api/messages/reply").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // …and the WS emit went to the right guest room with the right shape.
    // (The secure channel is up in this flow, so `content` is ciphertext —
    // decrypt with the conversation key to verify; uat-05 covers E2EE deeply.)
    await expect
      .poll(() => emitsOf(state, "sendMessage").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const sent = emitsOf(state, "sendMessage")[0].args[0];
    expect(sent.room).toBe(`guest-${GUEST.id}`);
    expect(sent.guestId).toBe(GUEST.id);
    expect(sent.sender).toBe("branch");
    const sentPlain = sent.e2ee
      ? await decryptWithKey(state.convKeyB64, JSON.parse(sent.content))
      : sent.content;
    expect(sentPlain).toBe("Yes — ready after 2 PM today.");

    // Ack succeeded → no failure UI.
    await expect(page.getByText(/failed to send/i)).toHaveCount(0);
  });

  test("typing: guest typing indicator shows and clears; admin keystrokes emit typing signals", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openDashboard(page, state);

    state.pushEvent("receiveMessage", guestMessage());
    await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });

    // Guest starts typing (room-scoped to the open thread).
    state.pushEvent("typing", { sender: GUEST.id, isTyping: true, guestRoom: `guest-${GUEST.id}` });
    await expect(page.locator(".typing-indicator")).toHaveText("Guest is typing...");

    // …and stops.
    state.pushEvent("typing", { sender: GUEST.id, isTyping: false, guestRoom: `guest-${GUEST.id}` });
    await expect(page.locator(".typing-indicator")).toHaveCount(0);

    // A typing signal for a DIFFERENT room must not leak into this thread.
    state.pushEvent("typing", { sender: "someone-else", isTyping: true, guestRoom: "guest-other" });
    await expect(page.locator(".typing-indicator")).toHaveCount(0);

    // Admin keystrokes emit typing=true, then the 1s debounce emits false.
    await page.getByPlaceholder("Type your reply…").pressSequentially("ok", { delay: 50 });
    await expect
      .poll(() => emitsOf(state, "typing").some((e) => e.args[0]?.isTyping === true), { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(() => emitsOf(state, "typing").some((e) => e.args[0]?.isTyping === false), { timeout: 5_000 })
      .toBe(true);
    // canonGuestRoom collapses ids that already carry the guest- prefix, so
    // guestId "guest-e2e-77" emits to room "guest-e2e-77" (not guest-guest-…).
    const t = emitsOf(state, "typing")[0].args[0];
    expect(t.room).toBe(GUEST.id);
    expect(t.sender).toBe(BRANCH.email);
  });

  test("hard guard: a message addressed to another branch is ignored", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openDashboard(page, state);

    state.pushEvent(
      "receiveMessage",
      guestMessage({ guestId: "guest-intruder", guestName: "Intruder", branchEmail: "other-branch@magis.test" })
    );

    // Give the handler a beat, then confirm nothing appeared.
    await page.waitForTimeout(1_500);
    await expect(page.getByText("Intruder")).toHaveCount(0);
    await expect(page.getByText("No active guest chats at the moment.").first()).toBeVisible();
  });
});
