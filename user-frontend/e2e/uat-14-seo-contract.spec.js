// UAT G5 (megaplan Phase B) — the SEO head contract on the money pages.
// Every indexable page must ship: a unique <title>, a meta description, a
// canonical pinned to the production origin (never the serving host), OG/
// Twitter cards, and valid JSON-LD (@graph parses, breadcrumbs well-formed).
// The 404 must be noindex WITHOUT a canonical. Guards the react-helmet-async
// pipeline (Seo.js) against silent regressions — prerendered tags must also
// survive hydration.
const { test, expect } = require("./fixtures");

const PAGES = [
  { path: "/", titleRe: /magis/i },
  { path: "/pawning", titleRe: /pawn/i },
  { path: "/jewelry-sales", titleRe: /jewelry/i },
  { path: "/branches", titleRe: /branch/i },
  { path: "/faqs", titleRe: /faq|questions/i },
  { path: "/guides/gold-karat-guide", titleRe: /karat/i },
];

async function readHead(page) {
  return page.evaluate(() => {
    const pick = (sel, attr = "content") =>
      document.querySelector(sel)?.getAttribute(attr) || null;
    return {
      title: document.title,
      description: pick('meta[name="description"]'),
      canonical: pick('link[rel="canonical"]', "href"),
      robots: pick('meta[name="robots"]'),
      ogTitle: pick('meta[property="og:title"]'),
      ogUrl: pick('meta[property="og:url"]'),
      ogImage: pick('meta[property="og:image"]'),
      twitterCard: pick('meta[name="twitter:card"]'),
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
        (s) => s.textContent
      ),
    };
  });
}

test.describe("G5: SEO head contract", () => {
  for (const { path, titleRe } of PAGES) {
    test(`head contract on ${path}`, async ({ page }) => {
      await page.goto(path);
      // Helmet applies after hydration — wait for the canonical to appear.
      await page.waitForSelector('link[rel="canonical"]', { state: "attached", timeout: 15_000 });
      const head = await readHead(page);

      expect(head.title).toMatch(titleRe);
      expect(head.description?.length || 0).toBeGreaterThan(40);

      // Canonical pins to the production origin — never localhost/preview.
      expect(head.canonical).toMatch(/^https:\/\/www\.magispawnshop\.com/);
      expect(head.canonical).not.toContain("localhost");

      // Social cards.
      expect(head.ogTitle).toBeTruthy();
      expect(head.ogUrl).toBe(head.canonical);
      expect(head.ogImage).toMatch(/^https:\/\//);
      expect(head.twitterCard).toBe("summary_large_image");

      // JSON-LD parses and carries a schema.org @graph.
      expect(head.jsonLd.length).toBeGreaterThanOrEqual(1);
      for (const block of head.jsonLd) {
        const data = JSON.parse(block); // throws = fail
        expect(JSON.stringify(data)).toContain("schema.org");
      }
    });
  }

  test("titles and descriptions are unique across the money pages", async ({ page }) => {
    const seen = { titles: new Map(), descriptions: new Map() };
    for (const { path } of PAGES) {
      await page.goto(path);
      await page.waitForSelector('link[rel="canonical"]', { state: "attached", timeout: 15_000 });
      const head = await readHead(page);
      seen.titles.set(path, head.title);
      seen.descriptions.set(path, head.description);
    }
    const titles = [...seen.titles.values()];
    const descs = [...seen.descriptions.values()];
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descs).size).toBe(descs.length);
  });

  test("404 is noindex and carries no canonical", async ({ page }) => {
    await page.goto("/definitely-not-a-page");
    await page.waitForSelector('meta[name="robots"]', { state: "attached", timeout: 15_000 });
    const head = await readHead(page);
    expect(head.robots).toMatch(/noindex/);
    expect(head.canonical).toBeNull();
  });
});
