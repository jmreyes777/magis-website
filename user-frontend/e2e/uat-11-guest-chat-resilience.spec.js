// UAT G2 — failure-path exploration for the guest chat: dead realtime layer,
// backend errors at session start, E2EE key service down, and expired-token
// recovery mid-conversation. The guest must always get honest feedback and a
// path forward — never a silent dead end.
const { test, expect } = require("@playwright/test");
const {
  mockGuestNetwork,
  fakeSocketIO,
  deadSocketIO,
  openSupportChat,
  waitForHydration,
  waitForSocketReady,
  callsTo,
} = require("./uat-fixtures");

test.describe.configure({ timeout: 90_000 });

test.describe("G2: guest chat resilience", () => {
  test("dead socket: offline banner appears, composer blocked — no silent limbo", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await deadSocketIO(page); // realtime layer down; REST still up
    await openSupportChat(page, expect);

    // The debounced (5s) offline banner must surface, telling the guest what
    // is happening instead of leaving a composer that silently eats messages.
    // (Reconnect backoff runs 5s→10s→15s… — give the verdict a wide window.)
    await expect(page.getByText(/you are currently offline/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByPlaceholder("Branch is currently offline")).toBeDisabled();
    expect(callsTo(state, "/api/messages/send").length).toBe(0);
  });

  test("guest/init 500: Contact Us shows a readable error, no crash, retry works", async ({ page }) => {
    const state = await mockGuestNetwork(page, { initFails: true });
    await fakeSocketIO(page, state);
    await page.goto("/contact-us");
    await waitForHydration(page, "button[aria-label='Start chat with support']");

    await page.getByRole("button", { name: /start chat with support/i }).click();
    await expect(page.getByText(/failed to start chat\. please try again\./i)).toBeVisible();
    await expect(page.locator(".guest-chat-box")).toHaveCount(0);

    // Backend recovers → the same button must work without a reload.
    state.initFails = false;
    await page.getByRole("button", { name: /start chat with support/i }).click();
    await expect(page.locator(".guest-chat-box")).toBeVisible({ timeout: 15_000 });
  });

  test("conversation-key outage: chat fails open to plaintext (documented trade-off)", async ({ page }) => {
    const state = await mockGuestNetwork(page, { convKeyFails: true });
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    await page.getByPlaceholder("Chat branch").fill("plain message during kms outage");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 })
      .toBe(1);

    // Fail-open: message still goes out, but as plaintext with e2ee=false —
    // availability wins, and we assert the flag is honest about it.
    const sent = callsTo(state, "/api/messages/send")[0].postData;
    expect(sent.e2ee).toBeFalsy();
    expect(sent.content).toBe("plain message during kms outage");
    await expect(page.getByText("plain message during kms outage")).toBeVisible();
  });

  test("expired guest token mid-chat: silent refresh + retried send succeeds", async ({ page }) => {
    const state = await mockGuestNetwork(page, { expireFirstSend: true });
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    await page.getByPlaceholder("Chat branch").fill("token expired under me");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // 401 → refresh-token → automatic second attempt → success. The guest
    // never sees an error; the bubble lands normally.
    await expect.poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 }).toBe(2);
    expect(callsTo(state, "/api/guest/refresh-token").length).toBeGreaterThanOrEqual(1);
    await expect(page.getByText("token expired under me")).toBeVisible();
    await expect(page.getByRole("button", { name: /^retry$/i })).toHaveCount(0);
  });
});
