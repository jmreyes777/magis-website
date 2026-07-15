// user-frontend/scripts/obs-drill.mjs
//
// OBS verification drill (observability megaplan): drives a real headless
// browser against a deployed site to exercise the client-side telemetry
// end-to-end — exactly what a human tester would do by hand:
//   1. load the site (fires RUM beacons: TTFB/FCP/LCP/route views),
//   2. throw an uncaught error + an unhandled rejection in the page,
//   3. navigate to /pawning (route-change RUM), then close (pagehide flush).
// Firestore-side assertions live in the operator's hands (or Cascade's):
// check clientErrors for the drill marker and rumDaily for today's rollup.
//
//   node scripts/obs-drill.mjs [siteUrl]
//
// Defaults to the staging worker URL. Uses the same puppeteer dependency the
// prerender step relies on — no new packages.
import puppeteer from "puppeteer";

const SITE = process.argv[2] || "https://magis-edge-worker-staging.magis-edge-worker.workers.dev";
const MARKER = `obs-drill-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: "new" });
try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[page console.error]", m.text().slice(0, 160));
  });
  // Telemetry network tap: prove whether beacons leave the page and what the
  // edge/backend answered — separates reporter bugs from pipeline bugs.
  page.on("response", (r) => {
    if (/\/api\/(client-errors|rum)/.test(r.url()))
      console.log(`[beacon] ${r.request().method()} ${r.url().slice(-40)} -> ${r.status()}`);
  });
  page.on("requestfailed", (r) => {
    if (/\/api\/(client-errors|rum)/.test(r.url()))
      console.log(`[beacon FAILED] ${r.method()} ${r.url().slice(-40)} -> ${r.failure()?.errorText}`);
  });

  console.log(`loading ${SITE} …`);
  await page.goto(SITE, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2500); // let hydration + first RUM beacons settle

  console.log(`throwing drill errors (marker: ${MARKER}) …`);
  await page.evaluate((marker) => {
    setTimeout(() => { throw new Error(`${marker} uncaught`); }, 0);
    Promise.reject(new Error(`${marker} rejection`));
  }, MARKER);
  await sleep(6000); // reporter debounce is 3s — leave margin

  console.log("navigating to /pawning for route-change RUM …");
  try {
    await page.goto(`${SITE.replace(/\/$/, "")}/pawning`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(4000);
  } catch (e) {
    console.log("(non-fatal) /pawning navigation:", e.message.slice(0, 120));
  }

  await page.close(); // pagehide → sendBeacon flush of anything pending
  console.log(`drill complete. marker: ${MARKER}`);
  console.log("verify: clientErrors docs containing the marker; rumDaily rollup within ~5 min.");
} finally {
  await browser.close();
}
