// UAT W6 — Branch Chat Dashboard: lifecycle + resilience.
//   • chatClosed removes the conversation and clears the open pane
//   • guestPresenceUpdate is AUTHORITATIVE: it prunes ghost rows, ghost
//     badges, and even the open thread (including the empty-set case)
//   • WS delivery-ack failure → failed bubble + Retry that actually recovers
//   • reply REST 500 → failed bubble + Retry, no duplicate bubbles
//   • dead realtime layer → dashboard shell stays usable, no crash
const { test, expect } = require("@playwright/test");
const {
  GUEST,
  mockNetwork,
  seedBranchSession,
  callsTo,
  emitsOf,
  guestMessage,
  waitForAdminSocket,
} = require("./fixtures");

async function openConversation(page, state) {
  await seedBranchSession(page);
  await page.goto("/admin/chats");
  await waitForAdminSocket(state, expect);
  state.pushEvent("receiveMessage", guestMessage());
  await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });
}

test.describe("W6: chat lifecycle + resilience", () => {
  test("chatClosed: conversation disappears and the open pane resets", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openConversation(page, state);

    state.pushEvent("chatClosed", { guestId: GUEST.id });

    await expect(page.getByText(GUEST.name)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("No active guest chats at the moment.").first()).toBeVisible();
    // The composer for the dead thread is gone too — no half-open ghost pane.
    await expect(page.getByPlaceholder("Type your reply…")).toHaveCount(0);
  });

  test("authoritative presence prunes ghost conversations, badges, and the open thread", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openConversation(page, state);

    // Second guest appears (unread badge on their row).
    state.pushEvent(
      "receiveMessage",
      guestMessage({ id: "gm-ben-1", guestId: "guest-e2e-88", guestName: "Ben", content: "Hello!" })
    );
    const benRow = page.locator("div.cursor-pointer", { hasText: "Ben" }).first();
    await expect(benRow).toBeVisible();

    // Server says: only Maria is actually connected → Ben's row must go.
    state.pushEvent("guestPresenceUpdate", [GUEST.id]);
    await expect(page.getByText("Ben")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText(GUEST.name)).toBeVisible();

    // Server says: nobody is connected → sidebar AND open thread reconcile to empty.
    state.pushEvent("guestPresenceUpdate", []);
    await expect(page.getByText(GUEST.name)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("No active guest chats at the moment.").first()).toBeVisible();
  });

  test("WS delivery-ack failure: failed bubble with Retry; retry recovers without duplicates", async ({ page }) => {
    const state = await mockNetwork(page, {
      mfaVerified: true,
      socket: "fake",
      sendMessageAckFails: true,
    });
    await openConversation(page, state);

    await page.getByPlaceholder("Type your reply…").fill("Please bring a valid ID.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // REST saved it, but the realtime relay refused → honest failed state.
    await expect(page.getByText(/failed to send/i)).toBeVisible({ timeout: 10_000 });
    const retryBtn = page.getByRole("button", { name: "Retry" });
    await expect(retryBtn).toBeVisible();

    // Relay recovers → Retry re-persists and clears the failure.
    state.sendMessageAckFails = false;
    const repliesBefore = callsTo(state, "/api/messages/reply").length;
    await retryBtn.click();
    await expect(page.getByText(/failed to send/i)).toHaveCount(0, { timeout: 10_000 });
    expect(callsTo(state, "/api/messages/reply").length).toBeGreaterThan(repliesBefore);

    // Exactly one bubble with the text — retry replaced, never duplicated.
    await expect(page.getByText("Please bring a valid ID.")).toHaveCount(1);
  });

  test("reply REST 500: failed bubble with Retry; recovery keeps a single bubble", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake", replyFails: true });
    await openConversation(page, state);

    await page.getByPlaceholder("Type your reply…").fill("We close at 6 PM.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByText(/failed to send/i)).toBeVisible({ timeout: 10_000 });

    // Backend recovers → Retry succeeds, failure clears, no duplicates.
    state.replyFails = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText(/failed to send/i)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("We close at 6 PM.")).toHaveCount(1);
  });

  test("dead realtime layer: dashboard shell renders and stays navigable (no crash, no ghost composer)", async ({ page }) => {
    // Default socket mode = refused handshakes (hermetic outage).
    const state = await mockNetwork(page, { mfaVerified: true });
    await seedBranchSession(page);

    const pageErrors = [];
    page.on("pageerror", (err) => {
      // Wake-lock permission denials are environmental noise, not app bugs.
      if (!/wake lock/i.test(err.message)) pageErrors.push(err.message);
    });

    await page.goto("/admin/chats");

    await expect(page.getByRole("heading", { name: "Branch Chat Dashboard" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("No active guest chats at the moment.").first()).toBeVisible({
      timeout: 15_000,
    });

    // Give reconnect loops a moment to do their worst, then assert stability.
    await page.waitForTimeout(3_000);
    expect(pageErrors).toEqual([]);
    await expect(page.getByRole("button", { name: /logout/i })).toBeVisible();
  });
});
