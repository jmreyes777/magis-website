// TST3: jewelry page — layaway calculator hydrates and computes; the Subasta
// FAQ (added 2026-07-15) opens and shows its answer.
const { test, expect } = require("./fixtures");

test("layaway calculator: default ₱5,000 → Option 2 ₱1,050 down; Option 1 → ₱500", async ({ page }) => {
  await page.goto("/jewelry-sales");

  // Everything is asserted INSIDE the calculator: the page's static explainer
  // copy also contains peso amounts and plan wording, which must never be able
  // to satisfy these assertions (it once did, pre-hydration — a real flake).
  const calc = page.locator(".jewelry-calculator");
  const hero = calc.locator(".jewelry-calc-hero-amount");
  await expect(hero).toHaveText("₱1,050"); // prerendered opt2 default

  // Hydration sentinel + first interaction: the prerendered snapshot is the
  // opt2 view, so ONLY a live React click can switch the hero to opt1's ₱500.
  await expect(async () => {
    await calc.getByRole("button", { name: "Option 1" }).click();
    await expect(hero).toHaveText("₱500", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await expect(calc.getByText("One-time payment within 2 weeks")).toBeVisible();

  // Change the price on Option 1: ₱10,000 → down ₱1,000, balance ₱9,000.
  await calc.getByRole("spinbutton").fill("10000");
  await expect(hero).toHaveText("₱1,000");
  await expect(calc.getByText("₱9,000", { exact: true })).toBeVisible();
});

test("Subasta FAQ accordion opens with the provided answer", async ({ page }) => {
  await page.goto("/jewelry-sales");
  const subasta = page.locator("details", { hasText: "What is Subasta?" });
  await subasta.locator("summary").click();
  await expect(
    subasta.getByText(/pre-owned pieces that have been acquired through pawnshop auction/i)
  ).toBeVisible();
});
