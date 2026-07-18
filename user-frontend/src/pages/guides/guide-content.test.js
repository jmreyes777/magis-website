// TST4 (testing megaplan): content guardrails. These pin the SEO invariants
// the guides were built on (SEO-OPTIMIZATION-PLAN) and the business claims
// that have already regressed once (the karat guide implying only 18/21/24K
// before 2026-07-15). Content edits that break structure or claims fail here
// BEFORE a build ships them.
import { GUIDES, GUIDE_LINKS } from "./guide-content";

const guides = Object.entries(GUIDES);

describe("every guide is structurally complete", () => {
  test.each(guides)("%s has path/title/description/h1/lead/sections/faqs", (name, g) => {
    expect(g.path).toMatch(/^\/guides\/[a-z0-9-]+$/);
    expect(g.title).toBeTruthy();
    expect(g.description).toBeTruthy();
    expect(g.h1).toBeTruthy();
    expect(g.lead).toBeTruthy();
    expect(Array.isArray(g.sections) && g.sections.length > 0).toBe(true);
    expect(Array.isArray(g.faqs) && g.faqs.length > 0).toBe(true);
    expect(typeof g.jsonLd).toBe("function");
  });

  test.each(guides)("%s: sections and FAQs carry non-empty text", (name, g) => {
    for (const s of g.sections) {
      expect(s.heading).toBeTruthy();
      // Two legit shapes: prose paragraphs (body) or HowTo steps (steps).
      const content = s.body || s.steps;
      expect(Array.isArray(content) && content.length > 0).toBe(true);
      for (const p of s.body || []) expect(p.trim().length).toBeGreaterThan(10);
      for (const st of s.steps || []) {
        expect((st.name || st.title || "").length).toBeGreaterThan(3);
        expect((st.text || "").length).toBeGreaterThan(10);
      }
    }
    for (const f of g.faqs) {
      expect(f.q.trim().length).toBeGreaterThan(5);
      expect(f.a.trim().length).toBeGreaterThan(20);
    }
  });
});

describe("SEO length budgets", () => {
  test.each(guides)("%s: title ≤ 75 chars, description 50–170 chars", (name, g) => {
    expect(g.title.length).toBeLessThanOrEqual(75);
    expect(g.description.length).toBeGreaterThanOrEqual(50);
    expect(g.description.length).toBeLessThanOrEqual(170);
  });
});

describe("business claims that must never silently regress", () => {
  const karat = GUIDES.karatGuide;
  const all = JSON.stringify(karat);

  test("karat guide states the full 10K–24K acceptance range in lead AND description", () => {
    expect(karat.lead).toMatch(/every karat from 10K to 24K/i);
    expect(karat.description).toMatch(/10K to 24K/i);
  });
  test("stamp table covers 417/585/750/875/916/965/999", () => {
    for (const stamp of ["417", "585", "750", "875", "916", "965", "999"]) {
      expect(all).toContain(stamp);
    }
  });
  test("the in-between karats are named (the 2026-07-15 fix)", () => {
    for (const k of ["12K", "14K", "16K", "20K", "22K", "23K"]) {
      expect(all).toContain(k);
    }
  });
  test("the Tagalog acceptance FAQ exists (rich-result target)", () => {
    expect(karat.faqs.some((f) => /Tumatanggap ba kayo ng 10K o 14K/i.test(f.q))).toBe(true);
  });
});

describe("cross-linking stays consistent", () => {
  test("GUIDE_LINKS point at real guide paths", () => {
    const paths = new Set(Object.values(GUIDES).map((g) => g.path));
    for (const link of GUIDE_LINKS) {
      expect(paths.has(link.to)).toBe(true);
      expect(link.label.trim().length).toBeGreaterThan(5);
    }
  });
});
