// TST3: regression-locks the 2026-07-15 content fix — the karat guide must
// state the full 10K–24K acceptance range (not just 18K/21K/24K) and carry
// the stamp table including 965 (Thai 23K).
const { test, expect } = require("./fixtures");

test("karat guide states the full accepted range and stamp table", async ({ page }) => {
  await page.goto("/guides/gold-karat-guide");
  await expect(page.locator("h1")).toContainText(/18K, 21K, 24K/i);
  await expect(page.getByText(/accepts every karat from 10K to 24K/i).first()).toBeVisible();
  await expect(page.getByText(/“965” for 23K/).first()).toBeVisible();
  await expect(page.getByText("Tumatanggap ba kayo ng 10K o 14K gold?")).toBeAttached();
});
