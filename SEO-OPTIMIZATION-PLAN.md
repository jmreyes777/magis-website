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
| SEO-2 | **No structured data (JSON-LD)** anywhere — no `Organization`/`LocalBusiness`, `FAQPage`, or `BreadcrumbList` | **High** | `index.html`, `src/pages/*` | 2 | ✅ Done (W2) |
| SEO-3 | **No `sitemap.xml`**; `robots.txt` has no `Sitemap:` directive | Med | `public/robots.txt`, `public/sitemap.xml` | 3 | ✅ Done (W3) |
| SEO-4 | **Broken social previews:** non-JS scrapers see only static `index.html` (generic description, **no `og:image`**) | **High** | `public/index.html` | 1 (default) / 4 (per-route) | ✅ Done (W1 default + W4 per-route) |
| SEO-5 | **Canonical uses `window.location.host`** → diverges across hosts (`*.workers.dev`, `*.onrender.com`, custom domain) | Med | `src/pages/Home-User-Page.js:177-182` + new `<Seo>` | 1 | ✅ Done (W1) |
| SEO-6 | **Soft-404:** `*` route does `<Navigate to="/">` instead of a real 404 (search engines see soft-404s) | Low-Med | `src/App.js:51` | 3 | ✅ Done (W3) |
| SEO-7 | **CSR render model:** per-page meta/JSON-LD injected client-side → invisible to non-JS crawlers/social (Google renders JS, so it's OK there) | Med | architecture | 4 | ✅ Done (W4) |
| SEO-8 | Semantic/a11y polish: image `alt` audit, heading order, descriptive link text, `manifest.json` completeness | Low | `src/**`, `public/manifest.json` | 5 | ✅ Done (W5) |

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
**Status: ✅ Implemented 2026-06-19** — JSON-LD parses VALID in both `public/` and `build/` output; production build clean (no new eslint warnings); CSP intact (`'nonce-xyz123'` ×2, **0** `unsafe-inline` in `script-src`). `ld+json` is a non-executable **data block**, so `script-src` does not gate it.

- **Sitewide** `Organization` + `WebSite` + `["PawnShop","LocalBusiness"]` `@graph` — **static in `index.html`** so even non-JS crawlers see it. Real NAP/socials sourced from the footer (Facebook, Instagram, head-office address, `+639620618672`, email).
- **`<Seo>` extended** with `breadcrumbs` + `jsonLd` props → emits one combined `@context`/`@graph` block via Helmet (client-rendered, Google-visible). `"<"` is escaped so data can't break out of `<script>`.
- **`FAQPage`** on `/faqs`: 25 Q&As extracted into `COMPANY_FAQS`/`REGULATORY_FAQS` — **single source** driving both the visible JSX *and* the JSON-LD. `git diff` confirms hero/intro/CTAs/footer **byte-identical** (only the two list bodies + `<Seo>` changed).
- **`BreadcrumbList`** added to all 7 sub-pages (Home omitted as root).
- *(Optional, deferred)* per-branch `PawnShop` from the Firestore `branches` collection — client-rendered.
- **Operator note:** keep the `index.html` NAP (address/phone) in sync with the footer and the official Google Business Profile for local-SEO consistency.
- **Verify (done):** JSON validated programmatically; CSP/`ld+json` checked in built HTML; FAQ diff confirms identical visible output. **Still recommended:** Google Rich Results Test once the domain serves over HTTPS.

## Wave 3 — Crawl infrastructure  *(Severity Med · Effort S · Risk None/Low)*
**Status: ✅ Implemented 2026-06-19** — `sitemap.xml` validates as XML (8 `<url>`s, absolute `SITE_ORIGIN` URLs) and `robots.txt` now declares it; the soft-404 redirect is replaced by a real `noindex` NotFound page. Production build clean (no new eslint warnings); both static files confirmed copied into `build/`.

- **`public/sitemap.xml`** created — 8 public routes, absolute `https://www.magispawnshop.com` URLs, with `lastmod`/`changefreq`/`priority`.
- **`robots.txt`** updated — added `Sitemap:` directive + `Disallow: /api/` (keeps everything else crawlable).
- **SEO-6 fixed:** the old orphaned `NotFound-User-Page.js` was rebuilt on-brand (hero + helpful links + `Footer`) and wired into `App.js`' catch-all (`<Navigate to="/">` removed, unused `Navigate` import dropped). It emits **`<Seo noindex>`**, and `<Seo>` now **omits `canonical` when `noindex`** so the 404 doesn't assert a self-canonical.
- **SEO-5** was already fixed in W1 (single `SITE_ORIGIN`).
- **Note:** this SPA still returns **HTTP 200** for unknown URLs (client-side 404); the `noindex` meta is the crawler signal. A true 404 status would need the edge worker / hosting (tie-in with the Wave 4 render-model decision).
- **Verify (done):** `[xml]` parse of `sitemap.xml` OK (8 urls); `robots.txt` parses with `Sitemap:`; build compiles; 404 route wired to `<NotFound>`.

## Wave 4 — Render model for non-JS crawlers/social  *(Severity Med · Effort M-L · Risk Med)*
**Status: ✅ Implemented 2026-06-19 (Option 3 — edge-worker per-route meta injection).** The edge worker (`magis-edge-worker/index.js`) already rewrites served HTML for CSP nonces; Wave 4 adds a self-contained `injectRouteMeta(html, pathname)` step **right after** the nonce substitution that mirrors each page's `<Seo>` values into the **static** `<head>` for non-JS scrapers. The React app/build is **byte-for-byte unchanged**.

- **What it injects** (8 known routes, keyed on the request pathname): rewrites `<title>`, `meta[name=description]`, `og:title`/`og:description`/`og:url`, `twitter:title`/`twitter:description`, and **adds** a `<link rel="canonical">` (the static HTML had none). `og:image`/`twitter:image`/`og:site_name`/`og:type` stay constant.
- **Fail-safe:** unknown paths (deep SPA links, `/admin`, hashed assets, `sitemap.xml`) match nothing → HTML returned **byte-identical**. Values are HTML-escaped; canonical added once (never duplicated).
- **Zero-regression:** runs AFTER nonce substitution and touches no `<script>`/nonce/CSP bytes; `node --check index.js` clean. Verified by a unit test against the real `build/index.html` — **112/112 assertions** (every route's tags correct, exactly one `<title>`/canonical/`og:title`, nonce placeholders untouched, non-routes byte-identical). Throwaway test was removed after.
- **JSON-LD:** sitewide `Organization`/`WebSite`/`PawnShop` is already **static** in `index.html` (W2, scraper-visible); per-page `BreadcrumbList`/`FAQPage` stay client-rendered (Google renders JS). Worker-side per-route JSON-LD is a possible future add — not required for social cards.
- **Alternatives (not chosen):** *Option 2 (react-snap)* — build-time prerender; React-18 hydration risk + Puppeteer. *Option 4 (CRA→Vite/Next SSR)* — durable but a separate migration project.
- **Deploy/DNS follow-ups:** the simplified local `dev-server.js` does **not** rewrite HTML (it pipes), so per-route meta only appears via the real worker — `curl` each route with a bot UA on the **staging** `*.workers.dev` and run the Facebook Sharing Debugger / Google Rich Results Test there (no prod domain required). Keep `ROUTE_META` in sync with `src/pages/*` `<Seo>` going forward.

## Wave 5 — Semantic & a11y polish  *(Severity Low · Effort S-M · Risk Low)*
**Status: ✅ Implemented 2026-06-19** — audit found the codebase already in good shape (every `<img>` had `alt`; social links had `aria-label`s; icons `aria-hidden`). Production build clean (no new eslint warnings) and the pre-existing `anchor-is-valid` warning is now resolved.

- **`manifest.json`** rebranded from the CRA stub ("React App") → real `name`/`short_name`/`description` + `lang: en-PH`, `scope`, `categories`. Validated as JSON in `build/`.
- **`alt` audit:** all 14 `<img>`s already had `alt`; fixed brand spelling **"Jewellery" → "Jewelry"** in the Header + Footer logo `alt`.
- **Headings:** every page had exactly one `<h1>` **except `/branches`** — added a visually-hidden `<h1 className="sr-only">` (confirmed Tailwind emits `.sr-only` in the built CSS, so zero visual change).
- **A11y (linter):** converted the email **`<a href="#">` → `<button type="button">`** (Header drawer) — resolves `jsx-a11y/anchor-is-valid`; added safe `border/padding/box-sizing/cursor` resets to `.drawer-social-btn` (no-ops for the sibling `<a>` links).
- **Deferred:** Lighthouse Core Web Vitals re-check (needs the live HTTPS domain).
- **Verify (done):** production build clean; `manifest.json` valid JSON with brand name; `.sr-only` present in built CSS; `anchor-is-valid` warning gone.

## Wave 6 — Keyword research & on-page intent alignment  *(Severity Med · Effort M · Risk Low)*
**Status: ✅ Implemented 2026-06-20** — pre-launch PH keyword research (free Google Autocomplete, EN+TL) applied to per-route meta + FAQ. Deliverables in `seo-research/` (`keyword-map.md`, `keyword-harvester.mjs`, `keywords.csv`/`.json` — 566 suggestions). Both builds clean; worker `node --check` clean.

- **Research:** bilingual intent→page map + a re-runnable harvester (no API key, `gl=ph`). Top demand: gold price / `presyo ng ginto`, `magkano ang sangla ng 18k/21k gold`, `pawnshop interest rate`, `bsp registered pawnshop`, Tagalog how-to (`ano ang sangla`, `paano mag-sangla`), and local `near me / open now`.
- **Phase A:** refined `ROUTE_META` (worker) + 5 pages' `<Seo>` titles/descriptions with bilingual money terms (`sangla`, `alahas`, `presyo ng ginto`, `near you`, `tubos`). Worker + client kept identical.
- **Phase B:** expanded `/faqs` to **32 Q&As** (7 new bilingual + 4 enriched) feeding `FAQPage` schema — interest **as low as 1%/mo (select branches)**, gold-jewelry-only, **free on-the-spot appraisal**, full accepted-ID list, `tubos`/`patubo`, layaway (hulugan), and **BSP + AMLC-registered**.
- **Deferred:** real search **volumes** (paid API e.g. DataForSEO, or free Google Ads Keyword Planner) and the post-launch **GSC Search Analytics** feedback loop (needs the live domain). Optional next: a gold-price/appraisal explainer for the large gold-price demand; `openingHoursSpecification` for "open now" intent.

## Deployment — how SEO changes reach staging  *(reference, confirmed 2026-06-20)*
FAQ + per-route titles verified live on the guest staging site after a Render build.

- **Topology (staging):** the guest SPA is its **own** Render service `magis-guest-staging.onrender.com` (NOT served by the backend). Backend API = `magis-website.onrender.com`; admin = `magis-admin-staging.onrender.com`. The Cloudflare edge worker `magis-edge-worker-staging` routes `/api`→backend and pages→guest (URLs in `magis-edge-worker/deploy-api.mjs`).
- **Frontend deploy:** Render builds `user-frontend` from GitHub `main` (Auto-Deploy = On Commit). **`git push` alone is not enough** — the build must *succeed on Render*; a failed build silently keeps the last good bundle live. `build/` is gitignored (nothing served from git). Render's content hashes differ from a local Windows build, so don't compare bundle filenames.
- **Edge worker (SEPARATE deploy):** `node deploy-api.mjs` in `magis-edge-worker/` (needs `CF_API_TOKEN`). Required so per-route `<title>`/meta + static JSON-LD reach non-JS crawlers & social link-previews. **Status: PENDING 2026-06-20** — `CF_API_TOKEN` not present in the dev shell; run the one-liner below to ship it.
- **Cache:** `index.html` updates immediately; `asset-manifest.json`/static chunks are edge-cached — hard-refresh (Ctrl+F5) to see changes.

---

## Side note (not SEO, flagged for awareness)

- `src/pages/ContactUs-User-Page.js` posts to **`http://localhost:5000/api/contact`** (hardcoded localhost) — this will fail in production. Out of scope for SEO; raising it for a separate fix.
