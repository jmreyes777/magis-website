// UAT G4 (megaplan Phase B) — the guest pages that had zero coverage:
// FAQs, Terms, Privacy Policy, the three untested guide hubs, and the real
// 404. Every page must render, hydrate without console/page errors (the
// fixtures' tripwire), and expose its primary interaction. Also locks the
// 2026-07-26 branches-page layout fix (sticky map / viewport-fit).
const { test, expect } = require("./fixtures");

test.describe("G4: guest info pages", () => {
  test("FAQs: accordions render and toggle; both sections present", async ({ page }) => {
    await page.goto("/faqs");
    await expect(page.getByRole("heading", { name: /frequently asked questions/i })).toBeVisible();

    // Native <details> accordions: first one opens and reveals its answer.
    const first = page.locator("details.faq-accordion").first();
    await expect(first).toBeAttached();
    const answer = first.locator("p, div").first();
    await expect(answer).toBeHidden();
    await first.locator("summary").click();
    await expect(answer).toBeVisible();

    // …and closes again.
    await first.locator("summary").click();
    await expect(answer).toBeHidden();

    // A healthy amount of content (two h2 sections, several questions).
    expect(await page.locator("details.faq-accordion").count()).toBeGreaterThanOrEqual(6);
    expect(await page.locator("h2").count()).toBeGreaterThanOrEqual(2);
  });

  test("Terms & Privacy Policy: render with real content (chat privacy-notice link target works)", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/terms/i);

    // The chat privacy notice links here (W8) — the target must be a real page.
    await page.goto("/privacy-policy");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/privacy/i);
    // DPA 2012 is the legal backbone of the chat consent copy.
    await expect(page.getByText(/data privacy act|republic act|10173/i).first()).toBeAttached();
  });

  test("guide hubs: gold prices, how to pawn, interest rates all render from the shared template", async ({ page }) => {
    await page.goto("/guides/gold-prices-appraisal");
    await expect(page.locator("h1")).toContainText(/gold/i);

    await page.goto("/guides/how-to-pawn");
    await expect(page.locator("h1")).toContainText(/pawn/i);

    await page.goto("/guides/pawnshop-interest-rates");
    await expect(page.locator("h1")).toContainText(/interest/i);
  });

  test("unknown route: real 404 with helpful links back into the site (no soft-404 redirect)", async ({ page }) => {
    await page.goto("/this-page-does-not-exist");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    // Still on the bad URL — a redirect to "/" would be a soft 404 (SEO-6).
    expect(page.url()).toContain("/this-page-does-not-exist");
    // Recovery: at least a link home plus one money page.
    await expect(page.locator('a[href="/"]').first()).toBeAttached();
    await expect(page.locator('a[href*="/pawning"], a[href*="/branches"]').first()).toBeAttached();
  });

  test("branches layout: sticky-map mechanism intact (map visible while browsing)", async ({ page }) => {
    // The branch list is Firestore-backed and empty hermetically, so a real
    // scroll-with-tall-list scenario can't exist here. Lock the MECHANISM the
    // 2026-07-26 fix relies on instead — each assertion is a regression that
    // has actually happened:
    await page.setViewportSize({ width: 390, height: 740 }); // stacked layout
    await page.goto("/branches");
    await page.waitForSelector("#map");

    const mobile = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#map"));
      return {
        position: cs.position,
        top: parseInt(cs.top, 10),
        // overflow-x:hidden on html/body silently disables sticky everywhere
        // (F-G12) — must be `clip`.
        htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
        bodyOverflowX: getComputedStyle(document.body).overflowX,
      };
    });
    expect(mobile.position).toBe("sticky");
    expect(mobile.top).toBeGreaterThan(0); // pinned below the fixed header
    expect(mobile.htmlOverflowX).toBe("clip");
    expect(mobile.bodyOverflowX).toBe("clip");

    // Desktop: map + search + list clamp into one viewport so the footer
    // stays below the fold (the original complaint).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    const desktop = await page.evaluate(() => {
      const map = document.querySelector("#map").getBoundingClientRect();
      const footer = document.querySelector("footer")?.getBoundingClientRect();
      return { mapBottom: map.bottom, footerTop: footer ? footer.top : Infinity };
    });
    expect(desktop.mapBottom).toBeLessThanOrEqual(900); // fully on screen
    expect(desktop.footerTop).toBeGreaterThanOrEqual(880); // below the fold
  });
});
