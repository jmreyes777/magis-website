// UAT G1 — the core guest journey: Contact Us → live Support chat → message
// round-trip. Runs the production bundle against a fake branch (mocked API +
// fake socket.io server), covering the send pipeline (optimistic bubble →
// REST persist → WS delivery ack), staff replies, typing signals, E2EE
// on-the-wire privacy, the sensitive-data pre-flight review, and live
// presence flips.
const { test, expect } = require("@playwright/test");
const {
  GUEST_ID,
  SUPPORT_EMAIL,
  encryptWithKey,
  decryptWithKey,
  mockGuestNetwork,
  fakeSocketIO,
  openSupportChat,
  waitForSocketReady,
  callsTo,
} = require("./uat-fixtures");

// The guest bundle is heavy; under full parallelism page loads alone can eat
// most of the default 30s budget. UAT tests get a bigger, still-bounded one.
test.describe.configure({ timeout: 60_000 });

test.describe("G1: guest chat workflow (Contact Us → Support)", () => {
  test("start chat → send → delivered → staff reply renders", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);

    // Presence header reflects the branch being online.
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });

    // Guest session was established through the real init endpoint.
    expect(callsTo(state, "/api/guest/init").length).toBe(1);

    // Send a message: optimistic bubble first, then REST persist + WS ack.
    await waitForSocketReady(state, expect);
    const input = page.getByPlaceholder("Chat branch");
    await input.fill("Hello, is my ring ready?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Hello, is my ring ready?")).toBeVisible();
    await expect
      .poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 })
      .toBe(1);
    await expect
      .poll(() => state.socketEmits.filter((e) => e.event === "sendMessage").length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // Draft cleared only on success — user can type the next message.
    await expect(input).toHaveValue("");

    // The branch side replies over the socket; it must render in the thread.
    state.pushEvent("receiveMessage", {
      id: "staff-1",
      sender: "branch",
      branchId: "support",
      branchEmail: SUPPORT_EMAIL,
      guestId: GUEST_ID,
      content: "Yes! Ready for pickup tomorrow.",
      message: "Yes! Ready for pickup tomorrow.",
      timestamp: new Date().toISOString(),
    });
    await expect(page.getByText(/ready for pickup tomorrow/i)).toBeVisible();
  });

  test("typing indicator appears and clears with staff typing signals", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    // The handler only honors signals whose sender is the branch itself.
    state.pushEvent("typing", { sender: SUPPORT_EMAIL, isTyping: true });
    await expect(page.getByText(/staff is typing/i)).toBeVisible();

    state.pushEvent("typing", { sender: SUPPORT_EMAIL, isTyping: false });
    await expect(page.getByText(/staff is typing/i)).toHaveCount(0);
  });

  test("E2EE: plaintext never leaves the page; encrypted staff reply decrypts", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    // Wait for the conversation key handshake.
    await expect
      .poll(() => callsTo(state, "/api/messages/conversation-key").length, { timeout: 15_000 })
      .toBe(1);

    const SECRET = "My address is 42 Mabini St, please deliver there";
    await page.getByPlaceholder("Chat branch").fill(SECRET);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 })
      .toBe(1);

    // On the wire: e2ee flag + ciphertext envelope, NOT the plaintext.
    const sent = callsTo(state, "/api/messages/send")[0].postData;
    expect(sent.e2ee).toBe(true);
    const envelope = JSON.parse(sent.content);
    expect(envelope.ciphertext).toBeTruthy();
    expect(envelope.iv).toBeTruthy();
    expect(sent.content).not.toContain("Mabini");
    // And it round-trips with the conversation key (same key the branch gets).
    expect(await decryptWithKey(state.convKeyB64, envelope)).toBe(SECRET);

    // On screen: the GUEST still sees plaintext, never the echoed ciphertext.
    await expect(page.getByText(SECRET)).toBeVisible();
    await expect(page.getByText(/"ciphertext"/)).toHaveCount(0);

    // Staff reply encrypted with the same conversation key must decrypt.
    const enc = await encryptWithKey(state.convKeyB64, "Sure — see you at branch 42!");
    state.pushEvent("receiveMessage", {
      id: "staff-e2ee-1",
      sender: "branch",
      branchId: "support",
      branchEmail: SUPPORT_EMAIL,
      guestId: GUEST_ID,
      content: JSON.stringify(enc),
      e2ee: true, // the real admin dashboard sets this on encrypted emits
      timestamp: new Date().toISOString(),
    });
    await expect(page.getByText(/see you at branch 42/i)).toBeVisible();
    await expect(page.getByText(/unable to decrypt/i)).toHaveCount(0);
  });

  test("sensitive-data pre-flight: card number triggers masked review before send", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    await page.getByPlaceholder(/chat branch|never share/i).fill("my card is 4111 1111 1111 1111");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Review card appears INSTEAD of sending; preview is masked.
    await expect(page.getByText(/security review/i)).toBeVisible();
    await expect(page.getByText("****-****-****-****")).toBeVisible();
    expect(callsTo(state, "/api/messages/send").length).toBe(0); // nothing sent yet

    // Explicit confirmation sends it.
    await page.getByRole("button", { name: /confirm & send/i }).click();
    await expect
      .poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 })
      .toBe(1);
  });

  test("failed send shows Retry; retry recovers once the backend is back", async ({ page }) => {
    const state = await mockGuestNetwork(page, { sendFails: true });
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await waitForSocketReady(state, expect);

    await page.getByPlaceholder("Chat branch").fill("Will this survive an outage?");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Bubble degrades to a failed state with an actionable Retry. (The auto
    // resend-on-reconnect effect can produce more than one failed attempt —
    // target the first.)
    const retryBtn = page.getByRole("button", { name: /^retry$/i }).first();
    await expect(retryBtn).toBeVisible({ timeout: 15_000 });

    state.sendFails = false; // backend "recovers"
    await retryBtn.click();
    await expect
      .poll(() => callsTo(state, "/api/messages/send").length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("button", { name: /^retry$/i })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("Will this survive an outage?")).toBeVisible();
  });

  test("offline branch disables composer; live presence flip re-enables it", async ({ page }) => {
    const state = await mockGuestNetwork(page, { branchOnline: false });
    await fakeSocketIO(page, state);
    await openSupportChat(page, expect);

    // Offline branch: status header + disabled input with explanatory placeholder.
    await expect(page.getByText("Offline", { exact: true })).toBeVisible({ timeout: 10_000 });
    const input = page.getByPlaceholder("Branch is currently offline");
    await expect(input).toBeDisabled();

    // Branch comes online (socket presence push) — composer must wake up.
    state.pushEvent("branchStatus", {
      branchEmail: SUPPORT_EMAIL,
      online: true,
      lastSeen: new Date().toISOString(),
    });
    await expect(page.getByText("Active Now")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByPlaceholder("Chat branch")).toBeEnabled();
  });
});
