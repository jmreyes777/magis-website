# Off-Page SEO Playbook — Magis Gold & Gems

Wave 5 of `SEO-OPTIMIZATION-PLAN.md`. Everything here happens OUTSIDE the
codebase — it needs the owner (or a delegate), not a developer. Items are
ordered by impact-per-hour. Revisit monthly.

Why this matters: for "pawnshop near me" / "sangla [city]" searches, Google
ranks the **local pack** (map results) above regular links. Local-pack rank is
driven by Google Business Profile signals (reviews, categories, photos,
Website links), NAP consistency across the web, and locally relevant links —
none of which code can fix.

---

## 1. Google Business Profile (GBP) — the highest-ROI channel

**One-time (per branch, all 11):**
- [ ] Claim/verify every branch's profile at business.google.com.
- [ ] Primary category: **Pawn shop**. Secondary: **Jewelry store** (only the
      7 branches that sell), **Jeweler** where relevant.
- [ ] Website field → the branch's own deep link, NOT the homepage:
      `https://www.magispawnshop.com/branches/<slug>` (slugs in
      `BRANCH-GBP-LINKS-PLAN.md` Appendix A). Done for some — audit all 11.
- [ ] Appointment URL → same branch URL with `?chat=1` (opens live chat).
- [ ] Hours, phone (branch-specific), full address — must match the website
      byte-for-byte (NAP consistency).
- [ ] 10+ photos per branch: storefront (day/night), interior, counter,
      signage, team. Geotagged phone photos are fine.

**Weekly (15 minutes):**
- [ ] One GBP Post per week on the main profile: subasta schedule, promo
      rates, new jewelry arrivals. Posts expire — consistency beats polish.
- [ ] Answer every new review (positive AND negative) within a week.

**Review engine (the single biggest local-pack lever):**
- [ ] Print a QR code per branch → that branch's Google review form
      (`g.page/r/<code>/review` short link from GBP).
- [ ] Counter script: after a successful redemption or purchase, staff asks
      "Kung ok po ang serbisyo, pa-scan lang po ng QR para sa review."
- [ ] Target: 2–5 new reviews per branch per month, steady. Never buy or
      incentivize reviews (violates Google policy; risks profile suspension).
- [ ] Ask happy customers to mention the SERVICE + CITY in the review
      ("mabilis mag-sangla sa Angeles") — keyword-rich reviews help ranking.

## 2. NAP consistency & local citations

Name, Address, Phone must be IDENTICAL everywhere. Master copy = the website's
branch pages / `llms.txt`.

- [ ] Audit + fix listings on: Facebook page(s), Instagram bio, Waze, Apple
      Maps (Business Connect), Bing Places, Yelp Philippines, yellow-pages.ph,
      PhilippineCompanies.com, FindYello PH.
- [ ] Local directories: Angeles City / Pampanga business directories, DTI
      listing consistency, Chamber of Commerce (Pampanga & QC) memberships —
      each gives a citation + a real local backlink.
- [ ] Any franchise/branch signage photos on third-party sites (e.g., old
      phone numbers) — request corrections.

## 3. Facebook & Instagram (existing strength — redirect it)

The FB page already posts actively. Small changes make it feed SEO:

- [ ] Every post that mentions a service should link the matching guide or
      page: subasta post → `/`, rate promo → `/guides/pawnshop-interest-rates`,
      "paano mag-sangla" explainer → `/guides/how-to-pawn`.
- [ ] Update page About section: website = `https://www.magispawnshop.com`,
      exact NAP for head office, services list.
- [ ] Pin a post linking the branch finder (`/branches`).
- [ ] Instagram bio link → homepage; story highlights per branch/service.

## 4. Earned links (slow burn, do opportunistically)

- [ ] Local news/blog outreach: Pampanga lifestyle blogs, SunStar Pampanga,
      Punto! Central Luzon — pitch a "how pawning works / how to spot fake
      gold" explainer quoting the owner (links to `/guides/...`).
- [ ] Sponsor a barangay/school event per branch area → event pages/posts
      linking the site.
- [ ] University finance orgs (Holy Angel, AUF) — free "how sangla interest
      works" talk + a link from the org's page to the interest-rate guide.
- [ ] BSP-registered pawnshop lists and fintech round-ups — request inclusion
      with a link.
- Never buy links or join link farms. One real Pampanga-local link outranks
  fifty spam directories and carries zero penalty risk.

## 5. Measurement (monthly, 20 minutes)

- [ ] Google Search Console: Performance → queries containing "sangla",
      "pawnshop", branch cities. Watch clicks + average position by page.
- [ ] GBP Insights per branch: search views, direction requests, calls.
- [ ] Review count + average rating per branch (spreadsheet, monthly snapshot).
- [ ] Rank-check 5 money keywords manually in an incognito window from a
      local IP: "pawnshop angeles city", "sangla pampanga", "magkano sangla
      18k", "pawnshop near me" (from a branch location), "subasta pampanga".

---

## Do NOT do

- Buy backlinks, reviews, or "SEO packages" promising #1 rankings.
- Create duplicate GBP profiles for the same branch.
- Stuff keywords into the GBP business name ("Magis Pawnshop Sangla Gold
  Angeles") — name must match signage or the profile gets suspended.
- Mass-submit to hundreds of foreign directories.
