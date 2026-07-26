// UAT W5 — Branch Chat Dashboard: E2EE + private media, staff side.
// Mirrors the guest suite's W3/W4 rigor from the other end of the wire:
//   • selecting a chat fetches the per-conversation AES key → banner flips to
//     "Encrypted (AES-256-GCM)" and replies leave ONLY as {ciphertext, iv}
//   • encrypted guest messages decrypt live in the thread
//   • key-service outage fails OPEN to plaintext with an honest banner
//     (availability-over-privacy — same product trade-off as the guest side)
//   • image replies upload multipart, carry a private storage path, and
//     resolve to a signed URL; resolve failures end in tap-to-retry, recover
const { test, expect } = require("@playwright/test");
const {
  GUEST,
  TINY_PNG,
  mockNetwork,
  seedBranchSession,
  callsTo,
  emitsOf,
  guestMessage,
  waitForAdminSocket,
  encryptWithKey,
  decryptWithKey,
} = require("./fixtures");

async function openConversation(page, state) {
  await seedBranchSession(page);
  await page.goto("/admin/chats");
  await waitForAdminSocket(state, expect);
  state.pushEvent("receiveMessage", guestMessage());
  await expect(page.getByText(GUEST.name)).toBeVisible({ timeout: 15_000 });
}

test.describe("W5: E2EE + media from the staff seat", () => {
  test("secure channel establishes on open; replies leave as ciphertext only; thread keeps plaintext", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openConversation(page, state);

    // Key fetched → banner confirms the secure channel.
    await expect(page.getByText("Encrypted (AES-256-GCM)")).toBeVisible({ timeout: 10_000 });
    expect(callsTo(state, "/api/messages/conversation-key/").length).toBeGreaterThanOrEqual(1);

    const secret = "Your loan balance is ₱12,500.";
    await page.getByPlaceholder("Type your reply…").fill(secret);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Staff still sees their own plaintext…
    await expect(page.getByText(secret)).toBeVisible();

    // …but the wire saw ciphertext, on BOTH channels. REST body:
    await expect
      .poll(() => callsTo(state, "/api/messages/reply").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const restBody = callsTo(state, "/api/messages/reply")[0].postData;
    expect(restBody.e2ee).toBe(true);
    expect(restBody.content).not.toContain(secret);
    const restPayload = JSON.parse(restBody.content);
    expect(await decryptWithKey(state.convKeyB64, restPayload)).toBe(secret);

    // Socket emit:
    await expect
      .poll(() => emitsOf(state, "sendMessage").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const wire = emitsOf(state, "sendMessage")[0].args[0];
    expect(wire.e2ee).toBe(true);
    expect(wire.content).not.toContain(secret);
    expect(await decryptWithKey(state.convKeyB64, JSON.parse(wire.content))).toBe(secret);
  });

  test("encrypted guest message decrypts live in the open thread", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openConversation(page, state);
    await expect(page.getByText("Encrypted (AES-256-GCM)")).toBeVisible({ timeout: 10_000 });

    const confidential = "My address is 123 Mabini St, Quezon City";
    const payload = await encryptWithKey(state.convKeyB64, confidential);
    state.pushEvent(
      "receiveMessage",
      guestMessage({ id: "gm-enc-1", content: JSON.stringify(payload), e2ee: true })
    );

    // Renders as plaintext — never as the raw {"ciphertext":…} blob.
    await expect(page.locator(".chat-messages").getByText(confidential)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".chat-messages").getByText(/"ciphertext"/)).toHaveCount(0);
  });

  test("conversation-key outage: honest failure banner, chat continues in plaintext", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake", convKeyFails: true });
    await openConversation(page, state);

    // Honest degraded-mode banner (fail-open is the documented product call).
    await expect(
      page.getByText("Secure connection failed - standard encryption only")
    ).toBeVisible({ timeout: 15_000 });

    const msg = "We are open until 6 PM.";
    await page.getByPlaceholder("Type your reply…").fill(msg);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(msg)).toBeVisible();

    // Wire carries plaintext with e2ee:false — an honest downgrade, not a lie.
    await expect
      .poll(() => emitsOf(state, "sendMessage").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const wire = emitsOf(state, "sendMessage")[0].args[0];
    expect(wire.e2ee).toBe(false);
    expect(wire.content).toBe(msg);
  });

  test("image reply: preview → multipart upload → private path resolves to a rendered image", async ({ page }) => {
    const state = await mockNetwork(page, { mfaVerified: true, socket: "fake" });
    await openConversation(page, state);
    await expect(page.getByText("Encrypted (AES-256-GCM)")).toBeVisible({ timeout: 10_000 });

    await page.locator('input[type="file"]').setInputFiles({
      name: "appraisal.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });

    // Local preview appears before sending.
    await expect(page.getByAltText("attachment preview")).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder("Type your reply…").fill("Here is the appraisal photo.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Upload went multipart to the reply endpoint.
    await expect
      .poll(() => callsTo(state, "/api/messages/reply").length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    expect(callsTo(state, "/api/messages/reply")[0].contentType).toContain("multipart/form-data");

    // The confirmed message's private path resolved to a signed URL and rendered.
    await expect(page.locator("img.attachment-image")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => callsTo(state, "/api/messages/admin-media/").length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("media resolve outage: bounded retries end in tap-to-retry, which recovers", async ({ page }) => {
    test.setTimeout(60_000); // the retry ladder alone is ~12s
    const state = await mockNetwork(page, {
      mfaVerified: true,
      socket: "fake",
      mediaResolveFails: true,
    });
    await openConversation(page, state);

    await page.locator('input[type="file"]').setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await expect(page.getByAltText("attachment preview")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // 1s/3s/8s ladder exhausts → explicit tap-to-retry, never an eternal spinner.
    await expect(page.getByRole("button", { name: /attachment unavailable/i })).toBeVisible({
      timeout: 25_000,
    });

    // Service recovers → tap → image renders.
    state.mediaResolveFails = false;
    await page.getByRole("button", { name: /attachment unavailable/i }).click();
    await expect(page.locator("img.attachment-image")).toBeVisible({ timeout: 10_000 });
  });
});
