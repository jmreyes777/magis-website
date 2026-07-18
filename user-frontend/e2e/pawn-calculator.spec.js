// TST3: the pawn interest calculator through a real browser on the real
// production build — proves prerendered HTML hydrates into a WORKING
// calculator (the money math itself is unit-tested in src/utils).
const { test, expect } = require("./fixtures");

test("renew estimate: ₱5,000 × 10 days → 1.0% → ₱50.00", async ({ page }) => {
  await page.goto("/pawning");

  // Hydration sentinel: React's useLayoutEffect autofills today's pawn date —
  // once it has a value, handlers are live and typing is safe.
  const pawnDate = page.locator("#pawnDate");
  await expect(pawnDate).not.toHaveValue("", { timeout: 15_000 });

  await page.locator("#principal").fill("5000");
  await pawnDate.fill("2026-01-01");
  await page.locator("#paymentDate").fill("2026-01-11"); // exactly 10 days

  await expect(page.getByText("10 days")).toBeVisible();
  await expect(page.getByText("1.0%")).toBeVisible();
  await expect(page.getByText(/estimated to renew/i)).toBeVisible();
  await expect(page.locator(".pawn-result__amount")).toHaveText("₱50.00");
});

test("redeem mode totals principal + interest; day 11 flips the tier", async ({ page }) => {
  await page.goto("/pawning");
  const pawnDate = page.locator("#pawnDate");
  await expect(pawnDate).not.toHaveValue("", { timeout: 15_000 });

  await page.locator("#principal").fill("5000");
  await pawnDate.fill("2026-01-01");
  await page.locator("#paymentDate").fill("2026-01-12"); // 11 days → 1.5%
  await expect(page.getByText("1.5%")).toBeVisible();

  await page.getByRole("tab", { name: /redeem/i }).click();
  await expect(page.getByText(/total to redeem/i)).toBeVisible();
  await expect(page.locator(".pawn-result__amount")).toHaveText("₱5,075.00"); // 5000 + 75
});
