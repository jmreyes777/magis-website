// CHAT-PARK — the parked-build contract: every guest chat entry point must be
// replaced by a working alternative (branch phone, Messenger, contact form),
// and NOTHING may reach for the chat stack (no /api/guest, /api/messages,
// /api/branch-status calls; no socket handshake; no Turnstile warm-up on
// /branches; no lazy guest-chat/guest-socket chunk downloads). Runs only
// against the default (chat OFF) build — playwright.config.js ignores it when
// REACT_APP_CHAT_ENABLED=true.
const { test, expect } = require("@playwright/test");
const { test: baseTest, expect: baseExpect } = require("./fixtures");
const {
  mockGuestNetwork,
  fakeSocketIO,
  waitForHydration,
  callsTo,
} = require("./uat-fixtures");

const CHAT_API_PREFIXES = ["/api/guest", "/api/messages", "/api/branch-status"];
const CHAT_CHUNK_RE = /guest-chat|guest-socket/;

const collectRequests = (page) => {
  const urls = [];
  page.on("request", (req) => urls.push(req.url()));
  return urls;
};

test.describe("CHAT-PARK: /contact-us (mocked network)", () => {
  test("chat entry is replaced by Messenger/call/branch links; form still works", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    const urls = collectRequests(page);
    await page.goto("/contact-us");
    await waitForHydration(page, "form input#name");

    // No chat entry point anywhere on the page.
    await expect(page.getByRole("button", { name: /chat with support/i })).toHaveCount(0);

    // Form fields intact.
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Message")).toBeVisible();

    // Parked alternatives (scoped to the card — the footer also has a
    // "Message us on Messenger" social link).
    const alt = page.locator(".contact-alt");
    await expect(alt.getByRole("link", { name: /message us on messenger/i }))
      .toHaveAttribute("href", "https://m.me/magispawnshop");
    await expect(alt.getByRole("link", { name: /call 0962-061-8672/i }))
      .toHaveAttribute("href", "tel:09620618672");
    await expect(alt.getByRole("link", { name: /find a branch near you/i }))
      .toHaveAttribute("href", "/branches");

    // The contact form is NOT chat — it must work exactly as before.
    await page.getByLabel("Name").fill("Juan dela Cruz");
    await page.getByLabel("Email").fill("juan@example.com");
    await page.getByLabel("Message").fill("Do you accept 18k gold?");
    await page.getByRole("button", { name: /send message/i }).click();
    await expect(page.getByText(/thank you for reaching out/i)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => callsTo(state, "/api/contact").length).toBe(1);

    // And nothing touched the chat stack.
    for (const prefix of CHAT_API_PREFIXES) {
      expect(callsTo(state, prefix), `unexpected ${prefix} calls`).toHaveLength(0);
    }
    expect(state.wsConnections, "a socket.io connection was attempted").toHaveLength(0);
    expect(urls.filter((u) => CHAT_CHUNK_RE.test(u)), "chat chunk was downloaded").toHaveLength(0);
  });
});

test.describe("CHAT-PARK: /branches/<slug>?chat=1 (mocked network)", () => {
  test("deep link focuses the branch but never opens chat", async ({ page }) => {
    const state = await mockGuestNetwork(page);
    await fakeSocketIO(page, state);
    // Registered AFTER mockGuestNetwork's catch-all so this shape wins.
    await page.route("**/api/site-config/branches", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "b-balibago",
            name: "Balibago",
            email: "balibago@magis.test",
            phone: "0917-123-4567",
            address: "MacArthur Hwy, Balibago, Angeles City",
            actualAddress: "MacArthur Hwy, Balibago, Angeles City",
            hasJewelryDisplay: false,
            location: { lat: 15.1636, lng: 120.5887 },
            schedule: [{ day: "Monday", open: true, openTime: "09:00", closeTime: "17:00" }],
          },
        ]),
      })
    );
    const urls = collectRequests(page);
    await page.goto("/branches/balibago-angeles?chat=1");
    await waitForHydration(page, ".branch-list");

    // Parked card: Call + Messenger, no chat button.
    await expect(page.getByRole("link", { name: "Call Balibago" }))
      .toHaveAttribute("href", "tel:09171234567", { timeout: 15_000 });
    await expect(page.locator(".branch-actions").getByRole("link", { name: /message us on messenger/i }))
      .toHaveAttribute("href", "https://m.me/magispawnshop");
    await expect(page.getByRole("button", { name: /^chat with/i })).toHaveCount(0);

    // ?chat=1 is accepted but ignored — no overlay, no backend touch.
    await page.waitForTimeout(2000);
    await expect(page.locator(".guest-chat-box")).toHaveCount(0);
    expect(callsTo(state, "/api/guest"), "guest session was created").toHaveLength(0);
    expect(state.wsConnections, "a socket.io connection was attempted").toHaveLength(0);
    expect(urls.filter((u) => u.includes("challenges.cloudflare.com")), "Turnstile was warmed").toHaveLength(0);
    expect(urls.filter((u) => CHAT_CHUNK_RE.test(u)), "chat chunk was downloaded").toHaveLength(0);
  });
});

// ── Base-fixture tests (./fixtures) — the hydration tripwire applies ──────────
baseTest.describe("CHAT-PARK: site chrome & copy", () => {
  baseTest("/faqs: footer swaps chat links for Messenger + contact form; page has no live-chat copy", async ({ page }) => {
    await page.goto("/faqs");

    const footer = page.locator("footer");
    await baseExpect(footer.getByRole("link", { name: /branch live chat/i })).toHaveCount(0);
    await baseExpect(footer.getByRole("link", { name: /customer support/i })).toHaveCount(0);
    await baseExpect(footer.getByRole("link", { name: "m.me/magispawnshop" }))
      .toHaveAttribute("href", "https://m.me/magispawnshop");
    await baseExpect(footer.getByRole("link", { name: "Send us a message" }))
      .toHaveAttribute("href", "/contact-us");

    const mainText = await page.locator("main").innerText();
    baseExpect(mainText).not.toMatch(/live chat/i);
  });

  baseTest("/pawning: chat CTAs become Find a Branch", async ({ page }) => {
    await page.goto("/pawning");
    await baseExpect(page.getByText(/chat with a branch|chat with our team/i)).toHaveCount(0);
    await baseExpect(page.locator("main").getByRole("link", { name: /find a branch/i }).first()).toBeVisible();
  });

  baseTest("/jewelry-sales: chat CTAs become Messenger links", async ({ page }) => {
    await page.goto("/jewelry-sales");
    await baseExpect(page.getByText(/chat with a branch|chat with our team/i)).toHaveCount(0);
    await baseExpect(page.locator("main").getByRole("link", { name: /message us on messenger/i }).first())
      .toHaveAttribute("href", "https://m.me/magispawnshop");
  });

  for (const path of ["/contact-us", "/branches", "/terms"]) {
    baseTest(`${path}: meta description does not mention chat`, async ({ page }) => {
      await page.goto(path);
      const content = await page.locator('meta[name="description"]').getAttribute("content");
      baseExpect(content).toBeTruthy();
      baseExpect(content).not.toMatch(/chat/i);
    });
  }
});
