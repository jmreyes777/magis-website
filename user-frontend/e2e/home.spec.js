// TST3: the front door — prerendered home must render, hydrate without
// errors, and expose the primary journeys (pawning, jewelry, branches).
const { test, expect } = require("./fixtures");

test("home renders with nav to the money pages", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/magis/i);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator('a[href*="/pawning"]').first()).toBeAttached();
  await expect(page.locator('a[href*="/jewelry-sales"]').first()).toBeAttached();
  await expect(page.locator('a[href*="/branches"]').first()).toBeAttached();
});
