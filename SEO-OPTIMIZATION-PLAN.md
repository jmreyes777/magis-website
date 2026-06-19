# SEO Optimization Plan — Magis Pawnshop & Jewelry (`user-frontend`)

- **Date:** 2026-06-19
- **Scope:** the public `user-frontend` SPA only. `admin-frontend` (private/Electron) and `backend` APIs are intentionally excluded from indexing.
- **Zero-regression principle:** no SEO change may weaken a security control (esp. the **nonce-based CSP / P3-1**, edge security headers), regress **`PERFORMANCE-PLAN.md`** work (static-map preload, resource hints, Core Web Vitals), or alter rendered page content/UX. Additive-only wherever possible.
- **Cross-reference:** `OWASP-2025-COMPLIANCE.md` (CSP nonce, edge worker), `PERFORMANCE-PLAN.md` (CWV, `index.html`).

## How to read this

- **Severity:** impact on organic discoverability (Critical / High / Med / Low).
- **Effort:** S (hours) · M (a day) · L (multi-day).
- **Risk:** regression risk to security/perf/UX (None / Low / Med / High).
- **Render-reach:** does the fix reach non-JS crawlers/social scrapers, or Google-only (JS-rendered)?

## Overall posture

**Foundation is decent, coverage is thin.** The app already uses `react-helmet-async` (SSR-safe) and the Home page has rich, correct meta. But **5 of 8 routes have no `<Helmet>` at all**, there is **zero structured data**, **no sitemap**, and **social previews are broken** for non-JS scrapers. The single biggest lever is **JSON-LD** (`LocalBusiness` + `FAQPage`) for a branch-based pawnshop. Nothing here requires weakening the CSP.

## Findings

| ID | Issue | Severity | Location | Wave | Status |
|----|-------|----------|----------|------|--------|
| SEO-1 | Incomplete per-page meta: `/branches`, `/contact-us`, `/terms`, `/privacy-policy`, `/faqs` have **no `<Helmet>`** (fall back to generic `Magis Website` title); `/jewelry-sales` & `/pawning` lack `canonical`+OG | **High** | `src/pages/*`, `src/App.js` | 1 | ✅ Done (W1) |
| SEO-2 | **No structured data (JSON-LD)** anywhere — no `Organization`/`LocalBusiness`, `FAQPage`, or `BreadcrumbList` | **High** | `index.html`, `src/pages/*` | 2 | Planned |
| SEO-3 | **No `sitemap.xml`**; `robots.txt` has no `Sitemap:` directive | Med | `public/robots.txt`, `public/sitemap.xml` | 3 | Planned |
| SEO-4 | **Broken social previews:** non-JS scrapers see only static `index.html` (generic description, **no `og:image`**) | **High** | `public/index.html` | 1 (default) / 4 (per-route) | 🟡 Default OG done (W1); per-route in W4 |
| SEO-5 | **Canonical uses `window.location.host`** → diverges across hosts (`*.workers.dev`, `*.onrender.com`, custom domain) | Med | `src/pages/Home-User-Page.js:177-182` + new `<Seo>` | 1 | ✅ Done (W1) |
| SEO-6 | **Soft-404:** `*` route does `<Navigate to="/">` instead of a real 404 (search engines see soft-404s) | Low-Med | `src/App.js:51` | 3 | Planned |
| SEO-7 | **CSR render model:** per-page meta/JSON-LD injected client-side → invisible to non-JS crawlers/social (Google renders JS, so it's OK there) | Med | architecture | 4 | **Decision** |
| SEO-8 | Semantic/a11y polish: image `alt` audit, heading order, descriptive link text, `manifest.json` completeness | Low | `src/**`, `public/manifest.json` | 5 | Planned |

## Zero-regression baseline (do not break)

- **CSP (P3-1):** `index.html` ships a nonce CSP (`script-src 'self' 'nonce-xyz123' …`) that the **edge worker rewrites per request**. Rules: (a) **never** add `'unsafe-inline'` to `script-src`; (b) any inline `<script>` added to `index.html` must carry `nonce="xyz123"` so the worker substitutes it; (c) JSON-LD uses `<script type="application/ld+json">` — a non-executed **data block** (not `script-src`-gated), but **verify in-browser under the real CSP** before shipping.
- **Performance:** leave the static-map `<link rel="preload">`, `#map-static-placeholder` + MutationObserver, and all resource hints untouched. Meta/JSON-LD are negligible bytes and must not become render-blocking.
- **Edge headers & SPA routing:** `X-Frame-Options: DENY`, COOP/COEP, proxy behavior, and client routes must be unchanged.

## Site origin (confirmed 2026-06-19)

- **Canonical origin: `https://www.magispawnshop.com`** (domain registered at **Squarespace**). Wired as a **single config constant** `SITE_ORIGIN` (from `process.env.REACT_APP_SITE_URL`), used for every `canonical`, `og:url`, and `sitemap.xml` entry — set once, swap once.
- **www vs apex:** canonical = **`www`** (robust default: clean CDN/DNS + cookie scoping). The apex `magispawnshop.com` should **301 → `www`**. One-line swap if you prefer the naked apex.
- **DNS / hosting (operator action — not code):** the domain is only *registered* at Squarespace; the app runs on the **Cloudflare edge worker + Render**. Point DNS at that infrastructure and add `www.magispawnshop.com` as the **Cloudflare Worker route + Render custom domain** (do **not** use Squarespace site hosting). Also add the new host to the worker's allowed-origins / CSP `connect-src` if required. All SEO URLs assume `www.magispawnshop.com` serves this app over HTTPS.

---

## Wave 1 — Per-page meta foundation  *(Severity High · Effort S-M · Risk None · reach: Google now + default social)*
**Status: ✅ Implemented 2026-06-19** — new `src/components/Seo.js` + `<Seo>` on all 8 routes + default OG/Twitter in `index.html`. Production build succeeds with **no new eslint warnings** (only pre-existing, unrelated ones); CSP untouched (no `<script>` added); `index.html` perf work intact. Canonical/OG now derive from a single `SITE_ORIGIN` (fixes SEO-5).

- New reusable **`<Seo>`** component (wraps `Helmet`): props `title`, `description`, `path` (→ absolute `canonical` + `og:url` from `SITE_ORIGIN`), `image`, `type`. Centralizes OG/Twitter so every page is consistent.
- Add `<Seo>` to the **5 bare pages** + complete **Jewelry/Pawn** (add canonical + OG).
- `App.js`: convert the default `<title>` into a sensible **title template** fallback.
- `index.html`: add **default OG/Twitter tags + `og:image`** (static) so non-JS social scrapers get a baseline card immediately (partial SEO-4 fix, no architecture change).
- **Verify:** `npm run build` clean; view-source each route in dev; confirm CSP unaffected (no console CSP violations); Home meta unchanged.

## Wave 2 — Structured data (JSON-LD)  *(Severity High · Effort M · Risk Low-Med · reach: Google; +social via W4)*
**Status: Planned**

- **Sitewide** `Organization` + `WebSite` + `LocalBusiness`/`PawnShop` (name "Magis Gold & Gem Pawnshop & Jewelry", founded 1996) — **static in `index.html`** so even non-JS crawlers see it.
- **`FAQPage`** on `/faqs`: extract the 25 hardcoded Q&As into a **single data array**, render both the existing JSX *and* the JSON-LD from it (one source of truth — **identical visible output**, zero content regression).
- **`BreadcrumbList`** per page.
- *(Optional)* per-branch `PawnShop` from the Firestore `branches` collection (name/address/hours/phone) — client-rendered (Google-visible).
- **Verify:** Google Rich Results Test on built HTML; CSP/in-browser check for `ld+json`; FAQ page visually identical pre/post refactor.

## Wave 3 — Crawl infrastructure  *(Severity Med · Effort S · Risk None/Low)*
**Status: Planned**

- Create **`public/sitemap.xml`** (8 routes, absolute URLs from `SITE_ORIGIN`).
- Update **`robots.txt`**: add `Sitemap:` directive; keep allowing crawl; optionally `Disallow: /api/`.
- Fix **SEO-5** (fixed canonical origin) and **SEO-6**: replace the soft-404 redirect with a real **NotFound page** (`<Seo>` `noindex`, helpful links) while keeping a sane catch-all.
- **Verify:** `sitemap.xml` validates; `robots.txt` parses; 404 route renders + emits `noindex`.

## Wave 4 — Render model for non-JS crawlers/social  *(Severity Med · Effort M-L · Risk Med · DECISION)*
**Status: Awaiting decision — see recommendation**

**Recommended: Option 3 — edge-worker per-route meta injection.** The worker already rewrites HTML for CSP nonces, so: the React app/build stays **byte-for-byte identical** (zero SPA-bundle risk), the worker **knows the canonical host**, it's only **8 known routes**, and it can be **fail-safe** (unknown path → no injection → current behavior). Injects per-route `<title>`/`description`/OG/`canonical` (+ optional JSON-LD) into the proxied HTML.

- **Alternatives:** *Option 2 (react-snap)* — build-time prerender; semi-unmaintained, React-18 hydration risk, adds Puppeteer. *Option 4 (CRA→Vite/Next SSR)* — durable but a separate project (matches the deferred security/perf migration).
- **Verify:** `curl` each route as a bot UA → confirm correct static `<title>`/OG; real-user SPA path unchanged; CSP intact.

## Wave 5 — Semantic & a11y polish  *(Severity Low · Effort S-M · Risk Low)*
**Status: Planned**

- Image `alt` audit (decorative → `alt=""`, meaningful → descriptive); verify one `<h1>`/page + ordered headings; descriptive link text; `lang` correct.
- Complete `manifest.json` (name/short_name/description/theme) for mobile/PWA signals.
- **Re-check Core Web Vitals** (Lighthouse) to confirm no regression from Waves 1-4.

---

## Side note (not SEO, flagged for awareness)

- `src/pages/ContactUs-User-Page.js` posts to **`http://localhost:5000/api/contact`** (hardcoded localhost) — this will fail in production. Out of scope for SEO; raising it for a separate fix.
