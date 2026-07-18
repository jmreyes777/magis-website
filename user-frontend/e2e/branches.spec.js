// TST3: the branches page loads its data from client-side Firestore, which
// this hermetic suite BLOCKS — the assertion here is graceful degradation:
// the shell must render (no white screen, no uncaught errors via the
// tripwire) even when the data layer is unreachable.
const { test, expect } = require("./fixtures");

test("branches page shell survives a dead data layer", async ({ page }) => {
  await page.goto("/branches");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator("body")).toContainText(/branch/i);
});
