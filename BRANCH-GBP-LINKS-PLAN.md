# Per-Branch Google Business Profile → Website Deep-Link Plan

- **Date:** 2026-06-21
- **Owner:** Magis (operator) + dev
- **Scope:** Make each branch's Google "Website" link (from Google Business Profile / Maps) land on a branch-specific destination on `www.magispawnshop.com` that highlights that branch and offers live chat.
- **Cross-reference:** `SEO-OPTIMIZATION-PLAN.md` (Wave 2 deferred per-branch `PawnShop` schema; Wave 4 edge-worker meta; deployment topology), `user-frontend/src/pages/Branches-List-User-Page.js`, `user-frontend/src/components/Seo.js`, `magis-edge-worker/index.js`.
- **Status (2026-07-13):** DEV HALF SHIPPED — Option B live (commits `9a02b99` site, `f441c7a` worker; staging-verified end-to-end: Render build serves the slug chunk, edge injects per-branch meta). **Operator half pending:** Appendix C real NAP → Phase 1 GBP listings → Phase 3.5 domain cutover → Phase 4 Website fields.
- **⚠ DOMAIN BLOCKER (discovered 2026-07-13):** `www.magispawnshop.com` currently serves a **Squarespace "Coming Soon" parking page** (`noindex`; DNS: `CNAME www → ext-sq.squarespace.com`). Every URL in this plan — and every canonical/sitemap/JSON-LD URL already shipped — points at that domain. **Phase 4 and all SEO indexing are blocked until the domain is cut over to the app** (see Phase 3.5).

---

## 1) Objective & outcome

When someone searches "Magis pawnshop" (or a branch/area) on Google and sees the **Locations** panel (like the Palawan Express example), the **Website** button on each branch should open that branch's page on our site — branch highlighted in the list/map, with a clear path into live chat — instead of the generic homepage.

**Definition of done:**
- Each verified branch GBP listing has its **Website** field set to a working branch URL.
- That URL highlights the correct branch and exposes "Chat with `<branch>`".
- (SEO-grade target) Each branch has a unique, indexable URL with its own meta + `PawnShop` structured data, present in `sitemap.xml`.

---

## 2) How it works (two halves)

- **Google half (operator action — NOT code):** the Website button comes from each branch's **Google Business Profile (GBP)** listing's **Website field**. Palawan shows it on individual branch listings because each verified listing has a site set. Code cannot change what Google displays; the GBP field is the switch.
- **Site half (code):** the URL in that field must resolve to a page that focuses the branch and offers chat.

Both halves are required. This plan sequences them so we never publish a dead link.

---

## 3) Current-state findings (codebase facts)

| Area | Finding | Implication |
|------|---------|-------------|
| Routing | `user-frontend/src/App.js` — React Router v6, single `/branches` → `BranchesMapView` (lazy). Catch-all `*` → `NotFound` (`noindex`). | No per-branch route yet; easy to add. |
| Branch data | `Branches-List-User-Page.js` fetches Firestore `collection(db,"branches")`; fields incl. `id` (doc id), `name`, `email`, `phone`, `actualAddress`/`address`, `schedule`, `location {lat,lng}`, `hasJewelryDisplay`. | **No `slug` field today.** Need a slug source. |
| URL params | Page already reads `useLocation()` + `URLSearchParams` (`?filter=jewelry`). | Adding `?b=`/`?chat=1` parsing is trivial. |
| Highlight | `handleBranchClickFromList(branch)` sets active branch, scrolls into view, centers map. | Reuse for deep-link focus. |
| Chat open | `openChatBox(branch)` runs Turnstile bot check + guest init + socket, then opens `GuestChatBox`. Needs `branch.email`, `branch.id`, `branch.name`, `branch.schedule`. | Reuse for `?chat=1`. Do NOT auto-run for every visit. |
| SEO helper | `user-frontend/src/components/Seo.js` supports `title`, `description`, `path` (→ canonical/OG from `SITE_ORIGIN=https://www.magispawnshop.com`), `noindex`, `breadcrumbs`, `jsonLd` (handles `PawnShop`/`LocalBusiness`). | Per-branch meta + schema ready to use. |
| Crawl infra | `user-frontend/public/sitemap.xml` (8 URLs), `robots.txt` (`Sitemap:` + `Disallow: /api/`). | Add per-branch URLs when implementing B. |
| Non-JS render | `magis-edge-worker/index.js` `injectRouteMeta()` rewrites static `<head>` for **8 known routes**; unknown paths returned byte-identical. SPA returns **HTTP 200** for unknown URLs (soft-404; `noindex` meta is the signal). | `/branches/<slug>` gets **Google-only** meta (client `<Seo>`) unless the worker is extended for social previews. |
| Deploy | Frontend = Render auto-deploy on commit to `main` (build must succeed). Edge worker = **separate** deploy `node deploy-api.mjs` (needs `CF_API_TOKEN`, currently pending). | Two deploy paths to remember. |
| Analytics | Site uses **no analytics trackers** (per privacy policy). | Track Website clicks via **GBP Performance** insights instead of UTM/site analytics. |

---

## 4) URL structure (decide once, set in GBP once)

- **Final (recommended, SEO-grade):** `https://www.magispawnshop.com/branches/<slug>`
  - Example: `https://www.magispawnshop.com/branches/balibago-angeles-city`
- **Auto-open-chat variant:** append `?chat=1` → `…/branches/balibago-angeles-city?chat=1`
- **Interim (works today, no code):** `https://www.magispawnshop.com/branches` (generic page) — use only as a temporary GBP target until routes ship.
- **Quick-mode alternative (Option A):** `https://www.magispawnshop.com/branches?b=<slug>&chat=1`

**Canonical rule:** `?b=`/`?chat=1` variants must canonical to the clean `/branches/<slug>` (or `/branches` in Option A) to avoid duplicate-URL dilution.

---

## 5) Slug strategy

- **Convention:** lowercase, hyphenated, ASCII; pattern `<area-or-barangay>-<city>`. Stable + unique. No "magis"/"pawnshop" (redundant with domain). Disambiguate same-city branches by barangay/landmark.
- **Source of truth (recommended):** add a dedicated **`slug` field to each Firestore `branches` doc** (admin action). Stable across renames → protects the GBP link and accumulated ranking.
- **Fallback (if a doc has no slug):** derive `slugify(name)`; on collision, append a short stable suffix (e.g. last 4 of `id`). Matching order at runtime: `slug` field → `slugify(name)` → `id`.
- **Deliverable:** a finalized **branch → slug → GBP Website URL** table (see Appendix A) before GBP setup.

---

## 6) Implementation options

### Option A — Quick deep link (query param)
- Parse `?b=<slug>` (+ `?chat=1`) in `BranchesMapView` after branches load → `handleBranchClickFromList(match)`; if `chat=1` → `openChatBox(match)`.
- **Effort:** S (≈1 file). **Risk:** None. **SEO:** weak (same `/branches` URL).
- **Use when:** you want GBP links working ASAP.

### Option B — SEO-grade per-branch routes (recommended)
- Add route `/branches/:slug` (reuse `BranchesMapView` via a wrapper or `useParams`).
- Read `:slug` → match branch → focus + (optional `?chat=1`) open chat.
- Per-branch `<Seo>`: unique `title`/`description`, `path=/branches/<slug>`, `breadcrumbs`, and `jsonLd` `PawnShop` (NAP + `geo` from `location` + `openingHoursSpecification` from `schedule`).
- Unknown slug → render `NotFound` (`noindex`) — no soft-200 branch page.
- Add all `/branches/<slug>` to `sitemap.xml`.
- (Optional, for social previews) extend worker `injectRouteMeta` to handle `/branches/*`.
- **Effort:** M. **Risk:** Low-Med. **SEO:** strong ("pawnshop near me", per-branch rich results).

**Recommendation:** Build **Option B** (it doubles as the deep link + the local-SEO win and matches the deferred Wave-2 item). Optionally ship Option A first if listings are ready before code.

---

## 7) Phased rollout (step by step)

### Phase 0 — Decisions & data prep  *(operator + dev)*
- [ ] Approve URL scheme `/branches/<slug>` (Section 4).
- [ ] Decide chat behavior: default = highlight + visible "Chat with X" button; auto-open only with `?chat=1`. (Confirm.)
- [ ] Decide slug source: **Firestore `slug` field** (recommended) vs derived. (Confirm.)
- [ ] Finalize **Appendix A** table (every branch → slug → final URL).
- [ ] Decide social-preview need for branch pages: extend worker (full reach) vs Google-only JS render (simpler).

### Phase 1 — GBP listings  *(operator; can run in parallel with Phase 2)*
- [ ] Create/claim **one verified listing per physical branch** at `business.google.com`.
- [ ] Complete Google **verification** for each (link won't show until verified).
- [ ] Set **primary category** `Pawn shop`; add `Jewelry store`/`Jeweler` where applicable.
- [ ] Set exact **NAP + opening hours** per branch; keep identical to site + `user-frontend/public/index.html` JSON-LD + footer.
- [ ] Mark/merge any **duplicate** listings.
- [ ] Temporarily set each **Website** field to `https://www.magispawnshop.com/branches` (working page) until routes ship.
- [ ] (If category supports it) set Appointment/Booking link to the `?chat=1` URL.

### Phase 2 — Site implementation  *(dev — Option B)*  ✅ 2026-07-13
- [x] Slug resolution shipped as `user-frontend/src/utils/branchSeo.js`: Firestore `slug` field (wins when added later) → static Appendix-A table → `slugify(name)` → doc id. No Firestore writes needed to go live.
- [x] Route `/branches/:slug` in `App.js` (reuses `BranchesMapView`).
- [x] `BranchesMapView`: slug → branch focus (list scroll + map center, both effect- and post-map-init paths); `?chat=1` → `openChatBox` exactly once.
- [x] Per-branch `<Seo>` via `buildBranchSeo` + `PawnShop` `jsonLd` (geo + `openingHoursSpecification`; placeholder phones filtered out).
- [x] Unknown slug → `NotFound` (`noindex`), only after branches load (no 404 flash).
- [x] `npm run build` clean.

### Phase 3 — Crawl infrastructure  *(dev)*  ✅ 2026-07-13
- [x] All 11 `/branches/<slug>` URLs added to `user-frontend/public/sitemap.xml` (static, matching the static slug table; revisit a generator only if branches churn).
- [x] `magis-edge-worker/index.js`: `BRANCH_META` (static Appendix-A table) + `branchRouteMeta()` feeding the existing `injectRouteMeta`; unknown slugs untouched; nonce/CSP substitution unchanged; `node --check` clean.
- [x] Worker re-deployed (`node deploy-api.mjs`) and staging-verified: branch URL returns per-branch `<title>`/OG/canonical, zero `xyz123` placeholder nonces; unknown slug returns default meta.

### Phase 3.5 — Domain cutover  *(operator + dev — BLOCKS Phase 4)*
The app stack (edge worker → Render origins) is live but only on staging hostnames; the real domain is parked at Squarespace. Cutover steps:
- [ ] **Cloudflare:** add `magispawnshop.com` as a zone on the existing CF account (`8cf3…b9f`, same one running the worker). Free plan suffices.
- [ ] **Squarespace (registrar):** replace the nameservers with the two Cloudflare gives. (Domain stays registered at Squarespace; only DNS moves. The Coming Soon page disappears with the old DNS.)
- [ ] **Cloudflare DNS:** after the zone activates, add proxied records for `www` and apex (worker routes need the hostname to resolve through CF — a proxied `AAAA 100::` / dummy `A 192.0.2.1` placeholder is the standard pattern for worker-only hostnames).
- [ ] **Worker routes:** attach `www.magispawnshop.com/*` (+ apex redirect → `www`) to the worker. Decide whether to keep the `magis-edge-worker-staging` script name or clone to a `magis-edge-worker-prod` script with prod env vars first.
- [ ] **Third-party allowlists** (dev can prepare, operator owns consoles): Firebase Auth authorized domains, Google Maps API key HTTP-referrer restrictions, Turnstile widget hostnames, backend CORS/`FRONTEND_URL(S)` env on Render — all must include `www.magispawnshop.com` before cutover.
- [ ] **Verify:** `https://www.magispawnshop.com/branches/balibago-angeles` returns the branch title with a fresh CSP nonce; chat + Turnstile + map all function on the real domain.

### Phase 4 — Point GBP to final URLs  *(operator)*
- [ ] After **Phase 3.5 is verified live** on the real domain, switch each listing's **Website** field from `/branches` → final `/branches/<slug>`.

### Phase 5 — Verify & measure
- [ ] Click the **Website** button on each listing → lands on correct branch.
- [ ] **Google Rich Results Test** on a branch URL → `PawnShop` valid.
- [ ] **Search Console** URL Inspection → indexable; submit updated sitemap.
- [ ] (If worker extended) **Facebook Sharing Debugger** on a branch URL → correct card.
- [ ] Track **GBP Performance → Website clicks** per branch (no site analytics needed).

---

## 8) Sequencing rule (avoid dead links)
1. Finalize slugs (Appendix A). 2. GBP Website → `/branches` (temporary). 3. Ship `/branches/<slug>`. 4. GBP Website → final per-branch URLs. 5. Verify. **Never** point GBP at `/branches/<slug>` before the route exists.

---

## 9) UX spec
- Land on the branch **highlighted + scrolled into view**, map centered.
- Show prominent **"Chat with `<branch>`"** button (existing).
- **Auto-open chat only** when URL has `?chat=1` (auto-opening for everyone fires the bot-check + creates guest sessions for bounces).

## 10) SEO spec (per-branch page)
- `<title>`: e.g. "Pawnshop in Balibago, Angeles City | Magis Gold & Gems".
- Meta description: branch + city + services (sangla/alahas/appraisal) + "near you".
- `PawnShop` JSON-LD: `name`, `address`, `geo` (from `location`), `telephone`, `openingHoursSpecification` (from `schedule`), `url` (canonical).
- `BreadcrumbList`: Home → Find a Branch → `<Branch>`.
- Canonical = clean `/branches/<slug>`.

## 11) Pitfalls / risks
- **Dead links** if GBP points to unbuilt routes (see Section 8).
- **Soft-404:** SPA returns 200; unknown slug must emit `noindex` (and ideally a real 404 via worker later).
- **NAP drift** across GBP/site/`index.html` JSON-LD hurts local ranking — keep in sync.
- **Auto-chat overload** — keep behind `?chat=1`.
- **Duplicate listings** — one per branch only.
- **Worker/CSP regression** — meta injection must not touch nonce/script bytes.
- **Render deploy** — `git push` isn't enough; the Render build must succeed.

## 12) Open decisions — RESOLVED 2026-07-13
- [x] Slug source: **hybrid** — Firestore `slug` field wins when present; until then the static Appendix-A table in `branchSeo.js` is authoritative; `slugify(name)`/doc-id as inbound-URL fallbacks.
- [x] Social previews: **worker extended** (CF_API_TOKEN blocker was stale — deploys work).
- [x] Auto-open chat: **off unless `?chat=1`** (fires once per landing).
- [x] **Straight to B** — no listings existed yet, so Option A bought nothing.

## 13) Acceptance criteria
- [ ] Every active branch has a verified GBP listing with Website → its `/branches/<slug>`.
- [ ] Each URL focuses the right branch + offers chat; `?chat=1` opens it.
- [ ] Each branch URL is indexable, in `sitemap.xml`, with valid `PawnShop` schema.
- [ ] No CSP/perf/eslint regressions; builds succeed on Render; worker `node --check` clean.

---

## Appendix A — Branch → slug → GBP Website URL

Source: `backend/branches.json` (11 branches; names + addresses). Slugs are **proposed defaults — editable**, but must be finalized before GBP Website fields are set. Final URL pattern: `https://www.magispawnshop.com/branches/<slug>`.

> ⚠ **Data quality:** the phone numbers (`123456789` / `1234567890`) and the uniform 9:00–17:00 daily hours in `branches.json` are **placeholder/seed data**, and several emails are test values. **Do NOT use them in GBP.** Collect real per-branch phone + hours (Appendix C) first — fake/placeholder NAP risks GBP suspension.

| # | Branch name | Area / City | Proposed slug | Final Website URL | Jewelry? | GBP verified? |
|---|-------------|-------------|---------------|-------------------|----------|---------------|
| 1 | Dolores | Dolores, San Fernando, Pampanga | `dolores-san-fernando` | `https://www.magispawnshop.com/branches/dolores-san-fernando` | Yes | ☐ |
| 2 | Mabalacat | Gil Puyat Ave, Mabalacat, Pampanga | `mabalacat` | `https://www.magispawnshop.com/branches/mabalacat` | Yes | ☐ |
| 3 | Balibago | Fields Ave, Balibago, Angeles City | `balibago-angeles` | `https://www.magispawnshop.com/branches/balibago-angeles` | No | ☐ |
| 4 | Pandacaqui | Pandacaqui, Mexico, Pampanga | `pandacaqui-mexico` | `https://www.magispawnshop.com/branches/pandacaqui-mexico` | No | ☐ |
| 5 | Madapdap | Madapdap, Mabalacat, Pampanga | `madapdap-mabalacat` | `https://www.magispawnshop.com/branches/madapdap-mabalacat` | No | ☐ |
| 6 | Rizal | Rizal St, Angeles City | `rizal-angeles` | `https://www.magispawnshop.com/branches/rizal-angeles` | Yes | ☐ |
| 7 | Dau | MacArthur Hwy, Dau, Mabalacat | `dau-mabalacat` | `https://www.magispawnshop.com/branches/dau-mabalacat` | No | ☐ |
| 8 | Don Gueco | Aniceto Gueco St, Angeles City | `don-gueco-angeles` | `https://www.magispawnshop.com/branches/don-gueco-angeles` | Yes | ☐ |
| 9 | Novaliches 1 | Buenamar Dr, Novaliches, Quezon City | `novaliches-buenamar-quezon-city` | `https://www.magispawnshop.com/branches/novaliches-buenamar-quezon-city` | Yes | ☐ |
| 10 | Novaliches 2 | Susano Rd, Novaliches, Quezon City | `novaliches-susano-quezon-city` | `https://www.magispawnshop.com/branches/novaliches-susano-quezon-city` | No | ☐ |
| 11 | N.S Amoranto | N.S. Amoranto St, La Loma, Quezon City | `amoranto-quezon-city` | `https://www.magispawnshop.com/branches/amoranto-quezon-city` | Yes | ☐ |

> Slug notes: the two Novaliches branches use the street (Buenamar / Susano) to stay unique and descriptive. "Jewelry? = Yes" → add `Jewelry store` as a GBP secondary category.

---

## Appendix B — Google Business Profile setup walkthrough (operator)

**Prep once**
- Use **one owner Google account** for all listings (a company Gmail/Workspace account). Add branch staff as **Managers** per location afterwards.
- Per branch, have ready: exact **signage name**, full **street address** (no plus-codes), **real local phone**, **real hours**, **category**, and the **Website URL** (Appendix A).

**Manual — per branch**
1. Go to `business.google.com` → sign in with the owner account.
2. Search the branch name + address. If a listing already exists → **Claim / Own this business**; otherwise **Add your business to Google**.
3. **Business name** = the real storefront name only (no "near me"/city keyword stuffing — Google can suspend).
4. **Primary category** = `Pawn shop`; add `Jewelry store` (secondary) for branches marked Jewelry = Yes.
5. "Do customers visit?" → **Yes** → enter the exact street address; drag the **map pin** to the exact door.
6. **Phone** = the branch's real local number. **Website** = the Appendix A URL (interim: `https://www.magispawnshop.com/branches` until per-branch routes ship — see Section 8).
7. Complete **verification** (video / postcard / phone — Google chooses what's eligible). The Website link/features stay limited until verified, so start this early.
8. After verified: set **hours** (+ special/holiday), add **photos** (storefront, interior, logo), a short **description** (no promos), and the opening date.
9. (If the category exposes it) set the **Appointment/booking link** to the `?chat=1` variant of the branch URL.

**Faster for 11 branches — bulk upload**
- In Business Profile Manager: create a **location group** → **Add locations → Import locations** using Google's spreadsheet template. The template's columns map to name / address / phone / **website** / category / hours, so you set all 11 per-branch URLs in one pass.
- Then request **bulk verification** (a brand with 10+ same-owner locations is typically eligible).
- **Pre-filled sheet ready (2026-07-13):** `seo-research/gbp-bulk-import.csv` — store codes = slugs, Website URLs, categories, lat/lng and draft addresses filled from branch data. **Before upload:** fill `Primary phone` + the seven hours columns from Appendix C, fix rows labeled `ADDRESS-WAS-PLUSCODE` (Google forbids plus-codes), and confirm each `Business name` matches the storefront signage (`CONFIRM-NAME` label).

**Guidelines (avoid suspension)**
- One listing per physical branch; flag/merge any duplicates.
- Keep **NAP identical** across GBP, the site, `user-frontend/public/index.html` JSON-LD, and the footer.
- Use **real local numbers** per branch (avoid one shared number if possible); no virtual offices.

---

## Appendix C — Real NAP to collect (replaces placeholder seed data)

Fill this in from official branch records, then we sync it to Firestore + `index.html` JSON-LD + GBP. Confirm or correct the Appendix-A address while you're at it.

| # | Branch | Confirmed street address (no plus-code) | Real local phone | Real opening hours | GBP business name (as on signage) |
|---|--------|-----------------------------------------|------------------|--------------------|------------------------------------|
| 1 | Dolores |  |  |  |  |
| 2 | Mabalacat |  |  |  |  |
| 3 | Balibago |  |  |  |  |
| 4 | Pandacaqui |  |  |  |  |
| 5 | Madapdap |  |  |  |  |
| 6 | Rizal |  |  |  |  |
| 7 | Dau |  |  |  |  |
| 8 | Don Gueco |  |  |  |  |
| 9 | Novaliches 1 |  |  |  |  |
| 10 | Novaliches 2 |  |  |  |  |
| 11 | N.S Amoranto |  |  |  |  |
