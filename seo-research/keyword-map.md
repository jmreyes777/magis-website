# Keyword → Intent → Page Map

**Market:** Philippine pawnshop & gold jewelry · **Brand:** Magis Gold & Gems Pawnshop & Jewelry · **Geo:** Angeles City / Pampanga / Central Luzon, PH

This is the **search-intent skeleton** for the site. Each public route owns **one primary intent** and a cluster of head + long-tail terms. Critically, this market searches in **English *and* Filipino/Taglish** — both are included. Validate/expand the terms with `keyword-harvester.mjs` (free, no key), and after launch with Google Search Console (real queries).

> Rule of thumb: **one primary intent per page.** Put the head term in the `title`/`H1`/`description`; put the long-tail questions into the **FAQ** (which already drives `FAQPage` JSON-LD from Wave 2).

---

## How this plugs into what's already built
- **Per-route meta (Wave 4):** each cluster's head term → that page's `title`/`description`/OG in `magis-edge-worker` `ROUTE_META` + the page's `<Seo>`.
- **FAQ schema (Wave 2):** every "question" keyword below → a Q&A on `/faqs` (or page-level FAQ) → rich results.
- **Branches + `h1` (Wave 5):** local "near me / city" terms → `/branches` and per-branch content + Google Business Profile.

---

## Clusters

### `/` — Home · *navigational + category* 
- **Head (EN):** pawnshop philippines · trusted pawnshop · gold buyer philippines
- **Taglish:** sanglaan · sangla · sanglaan ng alahas
- **Brand:** magis pawnshop · magis gold and gems
- **Apply:** title/H1/description (set in W1/W4). Reinforce "since 1996 / BSP-regulated / trusted".

### `/pawning` — Pawning service · *transactional + informational*
- **Head (EN):** pawn shop · pawn gold · pawnshop interest rate · pawn jewelry
- **Taglish:** sangla ng gold · sangla ng alahas · sangla ng cellphone · magkano ang sangla ng gold · patubo · tubos · prenda
- **Long-tail / questions (→ FAQ):** how does pawning work · paano mag-sangla · ano ang patubo · what ID do I need to pawn · pawnshop interest rate philippines
- **Apply:** title/description + body H2s ("How to pawn", "Accepted items", "Renew & redeem") + FAQ.

### `/jewelry-sales` — Jewelry sales · *commercial + transactional*
- **Head (EN):** gold jewelry · buy gold jewelry · 18k gold price · gold ring / necklace / earrings
- **Taglish:** alahas · singsing na ginto · kwintas na ginto · hikaw na ginto · pulseras na ginto · presyo ng ginto ngayon
- **Long-tail:** gold price today philippines · where to buy gold jewelry in pampanga · jewelry layaway / hulugan
- **Apply:** title/description + product copy + FAQ (layaway, authenticity, buyback).

### `/branches` — Branch finder · *local / transactional*  ← **highest local-SEO leverage**
- **Head:** pawnshop near me · pawnshop angeles city · pawnshop pampanga · sangla pampanga · pawnshop balibago · pawnshop open now
- **Apply:** city/region terms per branch, the `h1` (added W5), strict **NAP consistency** (must match footer + JSON-LD), and a **Google Business Profile** per branch (non-API, do this).

### `/faqs` — FAQs · *informational (long-tail questions)*  ← **best fit for `FAQPage` schema**
- **Questions:** pawnshop interest rate philippines · BSP pawnshop rules · what happens if I can't redeem my item · requirements sa sangla · is pawning safe · how is gold appraised · AMLA pawnshop · how to renew a pawn ticket · paano ang tubos
- **Apply:** each becomes a Q&A → expands the existing `COMPANY_FAQS`/`REGULATORY_FAQS` arrays → more `FAQPage` coverage.

### `/contact-us` — Contact · *navigational / support*
- **Terms:** pawnshop contact number · customer service · live chat · message pawnshop
- **Apply:** keep NAP + live chat prominent.

---

## Local SEO essentials (no API needed, high impact)
- **Google Business Profile** for each branch (categories: Pawn shop, Jewelry store, Jeweler) — biggest local-pack lever.
- **NAP consistency** everywhere (footer, JSON-LD, GBP, directories) — already aligned to the W2 schema.
- **Reviews** on GBP; respond to them.

## Seasonality to exploit (check Google Trends)
- **Gold price** interest spikes → time `/jewelry-sales` + buyback content.
- **Enrollment (Jun) & Christmas (Nov–Dec)** → pawn-demand spikes → promote `/pawning`.

## Workflow
1. **Harvest:** `node seo-research/keyword-harvester.mjs` → `keywords.csv` / `keywords.json` (PH Autocomplete, bilingual).
2. **Cluster:** sort by `page` + `intent`; pick **one** primary term per page, keep the rest as supporting/FAQ.
3. **Write:** head term → `title`/`description`/`H1`; questions → FAQ (`FAQPage` schema).
4. **Post-launch:** Google Search Console *Search Analytics API* → real queries/CTR/position → iterate the above.

---

## Validated findings — harvested 2026-06-20 (566 PH suggestions)
Output: `keywords.csv` / `keywords.json` (free Google Autocomplete, PH, EN+TL). Treat as **intent / long-tail discovery**, not volume.

**Top opportunities** (high intent, on-brand, low competitor-dependence):
- **Gold price (huge, recurring daily demand):** `presyo ng ginto ngayon`, `18k gold price per gram philippines today`, `gold price today philippines 18k/21k/22k/24k per gram`. → On `/jewelry-sales` (+ `/pawning`): speak to current gold price / per-karat basis; a short "how the gold price affects your appraisal" explainer captures big volume.
- **Pawn value of gold (commercial):** `magkano ang sangla ng 18k/21k gold`, `magkano sangla ng alahas`, `magkano sangla ng cellphone`, `pawn gold per gram/price`. → `/pawning` + FAQ: "How much can I pawn 18k/21k gold for?" (explain appraisal basis; bilingual).
- **Interest rate (trust + commercial):** `pawnshop interest rate philippines`, `pawnshop with lowest interest rate`, `how to compute pawnshop interest`. → FAQ explainer + state your rate clearly.
- **BSP legitimacy (trust):** `bsp registered pawnshop`, `bsp supervised pawnshops`, `bsp pawnshop regulations`. → Homepage trust signal + FAQ "Is Magis BSP-registered?".
- **Tagalog how-to (own the education competitors ignore):** `ano ang sangla`, `paano mag sangla ng alahas/cellphone/relo`, `requirements sa pag sangla`, `ano ang patubo`, `ano ang tubos`. → FAQ Q&As → feeds `FAQPage` schema.
- **Local "near me / open now":** `pawnshop near me open now`, `pawnshop angeles city open now`, `trusted pawnshop near me`. → `/branches` + Google Business Profile **hours**; add `openingHoursSpecification` to the LocalBusiness JSON-LD.
- **Jewelry products:** `gold ring/necklace design for men/women`, `gold ring/necklace price philippines`, `buy gold jewelry philippines`, `jewelry layaway plan philippines` / hulugan. → `/jewelry-sales` category copy + layaway.
- **Gadget/electronics pawning (scope decision):** strong `sanglaan ng cellphone/laptop/gadgets near me`, `pawnshop accepting gadgets near me`. → If accepted, add content; if not, a deliberate gap.

**Competitors seen** (target the *generic* of every feature they rank for — never their brand): Cebuana, Palawan, Villarica, M Lhuillier, CVM, RD, Sinag, Tambunting, PawnHero.

**Noise to ignore** (free-autocomplete homonyms/off-topic; the script's intent tag isn't perfect): `alahas sa panaginip` / `ni simoun`, `patubo ng buhok/pigsa/queen`, `gold ring sotn`, foreign `buy gold jewelry dubai/japan/canada`, `magic pawn shop chinese drama`.

**Recommended on-page actions** (fit existing infra, zero new architecture):
1. Refine `ROUTE_META` (worker) + page `<Seo>` titles/descriptions with the money terms above.
2. Expand `/faqs` (`COMPANY_FAQS` / `REGULATORY_FAQS`) with the bilingual questions → more `FAQPage` coverage.
3. Add `openingHoursSpecification` (+ `priceRange`) to the LocalBusiness/PawnShop JSON-LD.
4. *(Bigger)* a gold-price / appraisal explainer to capture the large gold-price demand.
