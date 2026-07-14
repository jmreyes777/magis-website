// src/pages/guides/guide-content.js
// SEO megaplan Wave 2 — content hub data. One primary search intent per guide
// (seo-research/keyword-map.md); every fact below comes from existing site
// copy (pawn page, FAQs, calculator table) — nothing invented. Visible content
// and JSON-LD are built from the SAME objects so Google's "FAQ markup must
// match the page" rule holds by construction.
import { SITE_ORIGIN, SITE_NAME } from "../../components/Seo";

// Shared publisher node reference (Organization @id lives in index.html's
// static JSON-LD; Article nodes reference it instead of duplicating NAP).
const ORG_ID = `${SITE_ORIGIN}/#organization`;

// Static revision date — bump when guide copy changes (never new Date():
// prerender snapshots must be byte-stable and honest).
export const GUIDES_PUBLISHED = "2026-07-14";

const article = ({ path, headline, description }) => ({
  "@type": "Article",
  "@id": `${SITE_ORIGIN}${path}#article`,
  headline,
  description,
  inLanguage: "en-PH",
  author: { "@id": ORG_ID },
  publisher: { "@id": ORG_ID },
  datePublished: GUIDES_PUBLISHED,
  dateModified: GUIDES_PUBLISHED,
  mainEntityOfPage: `${SITE_ORIGIN}${path}`,
});

const faqPage = (path, faqs) => ({
  "@type": "FAQPage",
  "@id": `${SITE_ORIGIN}${path}#faq`,
  mainEntity: faqs.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
});

// ---------------------------------------------------------------------------
// 1) /guides/gold-prices-appraisal — presyo ng ginto · how is gold appraised
// ---------------------------------------------------------------------------
const goldPrices = {
  path: "/guides/gold-prices-appraisal",
  title: "Gold Prices & Appraisal (Presyo ng Ginto) | Magis Gold & Gems",
  description:
    "How pawnshops appraise gold in the Philippines — karat, weight, and today's gold price (presyo ng ginto). Get a free, no-obligation appraisal at any Magis branch.",
  eyebrow: "Gold prices & appraisal",
  h1: "How gold is priced and appraised at a pawnshop.",
  lead:
    "Ang presyo ng ginto ngayon changes daily with the world market — here's how that turns into the exact peso amount an appraiser offers for your jewelry.",
  sections: [
    {
      heading: "What sets the price of gold (presyo ng ginto)?",
      body: [
        "Gold is traded worldwide, and its market price moves every day. Philippine pawnshops and jewelers start from that world price, convert it to pesos per gram, then adjust for the purity (karat) of your specific item.",
        "That's why nobody can promise one fixed “price of gold” for all jewelry: an 18K ring and a 24K coin of the same weight contain different amounts of pure gold, kaya magkaiba ang halaga.",
      ],
    },
    {
      heading: "How a Magis appraiser values your jewelry",
      body: [
        "Our trained appraisers assess three things: karat (purity), weight in grams, and the item's condition. The loan value is computed from your item's karat and weight at our posted branch rates — and we tell you the exact amount you can borrow before you decide anything.",
        "Appraisal at Magis is free, on the spot, and walang obligation. If you don't like the offer, you simply take your jewelry home — walang pilitan.",
      ],
    },
    {
      heading: "Paano mapapataas ang appraisal value?",
      body: [
        "Bring items with clear karat markings (like 18K or 750 stamps) and keep sets together — matched pieces are weighed and valued as-is. Gold jewelry with stones (e.g., diamonds) is carefully evaluated too.",
        "Ready to know today's value of your gold? Visit any branch for a free appraisal — no appointment needed.",
      ],
    },
  ],
  faqs: [
    {
      q: "Magkano ang presyo ng ginto ngayon sa pawnshop?",
      a: "Gold prices move daily with the world market. Magis posts its appraisal rates per branch, computed from your item's karat and weight — visit any branch for a free, no-obligation appraisal of your exact item today.",
    },
    {
      q: "How is gold appraised at a pawnshop?",
      a: "Appraisers assess karat (purity), weight in grams, and condition, then compute the value at the branch's posted rates. At Magis the appraisal is free and you're told the exact amount you can borrow before signing anything.",
    },
    {
      q: "Is the appraisal free? May bayad ba?",
      a: "Wala — appraisal at Magis Gold & Gems is completely free with no obligation to proceed. You can simply ask for your item's current value and take it home.",
    },
    {
      q: "Do you appraise gold jewelry with stones?",
      a: "Yes. Gold jewelry with stones such as diamonds is carefully evaluated — the gold content is appraised by karat and weight, and stones are considered in the overall assessment.",
    },
  ],
  related: [
    { label: "Gold karat guide: 18K vs 21K vs 24K", to: "/guides/gold-karat-guide" },
    { label: "How to pawn, step by step", to: "/guides/how-to-pawn" },
    { label: "Find a branch for a free appraisal", to: "/branches" },
  ],
  jsonLd: (g) => [article({ path: g.path, headline: g.h1, description: g.description }), faqPage(g.path, g.faqs)],
};

// ---------------------------------------------------------------------------
// 2) /guides/how-to-pawn — paano mag-sangla · how does pawning work
// ---------------------------------------------------------------------------
const HOWTO_STEPS = [
  {
    name: "Bring your gold jewelry and one valid ID",
    text: "Visit any Magis branch with your gold jewelry and one valid government-issued ID (required under AMLA/KYC rules).",
  },
  {
    name: "Get a free appraisal",
    text: "A trained appraiser assesses your item's karat, weight, and condition at the branch's posted rates — free and on the spot.",
  },
  {
    name: "Review the offer and terms",
    text: "We tell you the exact loanable amount, interest, charges, and maturity dates. Ipapaliwanag nang maayos — walang hidden charges.",
  },
  {
    name: "Decide — walang pilitan",
    text: "Proceed only if you're happy with the offer. If not, take your jewelry home; the appraisal costs nothing.",
  },
  {
    name: "Sign your pawn ticket and receive cash",
    text: "Your pawn ticket is your official contract — keep it safe. Receive your cash within minutes.",
  },
  {
    name: "Renew (patubo) or redeem (tubos) before maturity",
    text: "On or before the maturity date, pay the interest to renew your term, or pay principal plus charges to redeem your item. Your jewelry stays in secure storage the whole time.",
  },
];

const howToPawn = {
  path: "/guides/how-to-pawn",
  title: "How to Pawn (Paano Mag-Sangla) — Step by Step | Magis Gold & Gems",
  description:
    "Paano mag-sangla ng gold sa pawnshop: requirements (valid ID), free appraisal, pawn ticket, renewal (patubo) and redemption (tubos) — the complete 6-step guide.",
  eyebrow: "Paano mag-sangla",
  h1: "How to pawn your gold, step by step.",
  lead:
    "First time to pawn (mag-sangla)? Here's the entire process at a BSP-regulated pawnshop — from walking in with your jewelry to getting your cash in minutes.",
  sections: [
    {
      heading: "What you need (requirements sa sangla)",
      body: [
        "Just two things: your gold jewelry and one valid government-issued ID. The ID is required by law under AMLA/KYC rules — it protects you and keeps every transaction on the record.",
        "Accepted items include rings, necklaces, bracelets, earrings, and pendants — appraised by karat and weight. Gold jewelry with stones is carefully evaluated too.",
      ],
    },
    {
      heading: "The 6 steps, from appraisal to cash",
      steps: HOWTO_STEPS,
    },
    {
      heading: "After you pawn: renewing and redeeming",
      body: [
        "Your pawn ticket shows the exact charges and dates. To renew (magpatubo), visit any branch on or before maturity, present your ticket and ID, and pay the interest — this extends your term while your item stays safely stored.",
        "To redeem (tumubos), pay the principal plus the charges due with your original ticket and valid ID. An authorized representative can redeem for you with an authorization letter, their valid ID, and your ticket.",
        "If an item is not redeemed after the term and grace period, it may be included in the monthly subasta (auction) following BSP rules and notices — deadlines are always explained clearly before you sign.",
      ],
    },
  ],
  faqs: [
    {
      q: "Ano ang requirements para mag-sangla?",
      a: "Your gold jewelry plus one valid government-issued ID. Appraisal is free and you'll know the exact loanable amount before deciding.",
    },
    {
      q: "Gaano katagal ang proseso ng sangla?",
      a: "Minutes. Appraisal is done on the spot, and once you accept the offer and sign your pawn ticket, you receive your cash immediately.",
    },
    {
      q: "Ano ang mangyayari kung hindi ko matubos ang sangla ko?",
      a: "If the loan term and grace period lapse without renewal or redemption, the item may be included in the scheduled monthly subasta (auction) following BSP rules and notices. All deadlines are explained clearly before you sign.",
    },
    {
      q: "Can someone else redeem my item for me?",
      a: "Yes — an authorized representative needs an authorization letter, their valid ID, and your original pawn ticket.",
    },
  ],
  related: [
    { label: "Pawnshop interest rates, patubo & tubos explained", to: "/guides/pawnshop-interest-rates" },
    { label: "Full pawning service details + interest calculator", to: "/pawning" },
    { label: "Find your nearest branch", to: "/branches" },
  ],
  jsonLd: (g) => [
    article({ path: g.path, headline: g.h1, description: g.description }),
    {
      "@type": "HowTo",
      "@id": `${SITE_ORIGIN}${g.path}#howto`,
      name: "How to pawn (sangla) gold jewelry at Magis Gold & Gems",
      description: g.description,
      totalTime: "PT15M",
      supply: [
        { "@type": "HowToSupply", name: "Gold jewelry" },
        { "@type": "HowToSupply", name: "One valid government-issued ID" },
      ],
      step: HOWTO_STEPS.map((s, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: s.name,
        text: s.text,
      })),
    },
    faqPage(g.path, g.faqs),
  ],
};

// ---------------------------------------------------------------------------
// 3) /guides/gold-karat-guide — 18k vs 21k vs 24k · magkano ang sangla ng 18k
// ---------------------------------------------------------------------------
const karatGuide = {
  path: "/guides/gold-karat-guide",
  title: "Gold Karat Guide: 18K vs 21K vs 24K (Sangla Value) | Magis Gold & Gems",
  description:
    "What 18K, 21K, and 24K gold mean, how to read karat stamps (750, 875, 999), and how karat affects how much you can pawn (magkano ang sangla ng 18k/21k gold).",
  eyebrow: "Gold karat guide",
  h1: "18K, 21K, 24K: what karat means for your gold's value.",
  lead:
    "Karat measures how much pure gold your jewelry contains — and it's the single biggest factor in how much you can pawn or sell it for.",
  sections: [
    {
      heading: "Karat, explained simply",
      body: [
        "Pure gold is 24 karats (24K). Because pure gold is soft, jewelry mixes it with stronger metals — the karat tells you the proportion of gold in that mix: 18K is 18 parts gold out of 24 (75% gold, often stamped “750”), 21K is 87.5% gold (stamped “875”), and 24K is 99.9% pure gold (stamped “999”).",
        "Common stamps on Philippine jewelry: “750” for 18K, “875” for 21K (also called “Saudi gold” colloquially), and “999” for 24K. Look inside rings, on clasp tags of necklaces, and on the posts of earrings.",
      ],
    },
    {
      heading: "Magkano ang sangla ng 18K o 21K gold?",
      body: [
        "The loanable amount is computed from your item's karat and weight at the branch's posted rates — higher karat and heavier weight both raise the value. A 21K necklace outvalues an 18K one of the same weight because it contains more pure gold.",
        "Since gold prices move daily, the accurate answer for your item comes from a free branch appraisal — you'll get the exact loanable amount, walang obligation.",
      ],
    },
    {
      heading: "Karat tips before you pawn or sell",
      body: [
        "Don't polish off or damage karat stamps — they help the appraisal go faster. Keep matching sets together, and bring items with their original markings when possible.",
        "Not sure what karat your jewelry is? Our appraisers verify purity as part of the free appraisal — you don't need to know the karat beforehand.",
      ],
    },
  ],
  faqs: [
    {
      q: "Ano ang mas mataas na value, 18K o 21K?",
      a: "21K — it contains 87.5% pure gold versus 75% for 18K, so at the same weight a 21K item appraises higher.",
    },
    {
      q: "What do the 750, 875, and 999 stamps mean?",
      a: "They're purity markings: 750 = 18K (75% gold), 875 = 21K (87.5% gold), 999 = 24K (99.9% pure gold). You'll usually find them inside rings or on clasps.",
    },
    {
      q: "Paano ko malalaman ang karat ng alahas ko kung walang stamp?",
      a: "Bring it to any Magis branch — verifying karat is part of the free appraisal, so you don't need to know it beforehand.",
    },
    {
      q: "Magkano ang sangla ng 18k gold per gram?",
      a: "It depends on the day's gold price and the branch's posted rates — the loan value is computed from karat and weight. Visit any branch for a free appraisal to get the exact amount for your item.",
    },
  ],
  related: [
    { label: "How gold prices & appraisal work", to: "/guides/gold-prices-appraisal" },
    { label: "Ready to pawn? The step-by-step guide", to: "/guides/how-to-pawn" },
    { label: "Browse gold jewelry for sale", to: "/jewelry-sales" },
  ],
  jsonLd: (g) => [article({ path: g.path, headline: g.h1, description: g.description }), faqPage(g.path, g.faqs)],
};

// ---------------------------------------------------------------------------
// 4) /guides/pawnshop-interest-rates — pawnshop interest rate · patubo · tubos
// ---------------------------------------------------------------------------
const interestRates = {
  path: "/guides/pawnshop-interest-rates",
  title: "Pawnshop Interest Rates, Patubo & Tubos Explained | Magis Gold & Gems",
  description:
    "How pawnshop interest works in the Philippines — sample Magis rates from 1% (first 10 days), what patubo (renewal) and tubos (redemption) cost, and how to pay less.",
  eyebrow: "Interest rates · patubo · tubos",
  h1: "Pawnshop interest rates, explained clearly.",
  lead:
    "Interest is the cost of your pawn loan — and the earlier you renew or redeem, the less you pay. Here's exactly how it works, with sample Magis rates.",
  sections: [
    {
      heading: "How pawnshop interest works",
      body: [
        "When you pawn (mag-sangla), you receive a loan against your jewelry. Interest accrues on that principal over time, and the exact rates, charges, and grace periods are printed on your pawn ticket — your official contract.",
        "BSP-regulated pawnshops like Magis must disclose all charges before you sign. Walang hidden charges: you'll know the interest, the maturity date, and the grace period up front.",
      ],
    },
    {
      heading: "Sample Magis interest schedule",
      body: [
        "As a sample guide (actual rates vary per branch and are printed on your ticket): within the first 10 days interest is as low as 1.0% of the principal; up to 20 days, 1.5%; up to 30 days, 3.0%; up to 60 days, 8.5%; up to 90 days, 14.5%; and it continues rising the longer the pawn runs.",
        "The pattern to remember: bayad nang maaga, mas mura. Redeeming or renewing in the first days costs a fraction of waiting months. Use the interest calculator on our pawning page to estimate your exact charges by date.",
      ],
    },
    {
      heading: "Patubo (renewal) vs tubos (redemption)",
      body: [
        "Patubo / renewal: pay just the interest due on or before maturity to extend your term. Your item stays in secure storage and you keep the option to redeem later.",
        "Tubos / redemption: pay the principal plus charges due to take your jewelry home. Bring your original pawn ticket and a valid ID; representatives also need an authorization letter.",
        "If neither happens within the term and grace period, the item may be auctioned in the monthly subasta following BSP rules and notices.",
      ],
    },
  ],
  faqs: [
    {
      q: "Magkano ang interest sa pawnshop?",
      a: "At Magis, sample rates start as low as 1% of the principal within the first 10 days, rising the longer the pawn runs (e.g., 3% up to 30 days). Actual rates vary per branch and are printed on your pawn ticket before you sign.",
    },
    {
      q: "Ano ang ibig sabihin ng patubo?",
      a: "Patubo means renewing your pawn: you pay only the interest due on or before the maturity date to extend the term while your item stays in secure storage.",
    },
    {
      q: "Ano ang tubos at magkano?",
      a: "Tubos means redeeming your item: you pay the principal plus the charges due, present your original pawn ticket and valid ID, and take your jewelry home.",
    },
    {
      q: "Paano gumagana ang grace period?",
      a: "After maturity there is a grace period (printed on your ticket) during which you can still renew or redeem. Only after both lapse can the item be included in the monthly auction, following BSP rules and notices.",
    },
  ],
  related: [
    { label: "Estimate your charges with the interest calculator", to: "/pawning" },
    { label: "How to pawn, step by step", to: "/guides/how-to-pawn" },
    { label: "Read all pawning FAQs", to: "/faqs" },
  ],
  jsonLd: (g) => [article({ path: g.path, headline: g.h1, description: g.description }), faqPage(g.path, g.faqs)],
};

export const GUIDES = {
  goldPrices,
  howToPawn,
  karatGuide,
  interestRates,
};

// Convenience list for cross-linking ("More guides") and sitemaps.
export const GUIDE_LINKS = [
  { to: goldPrices.path, label: "Gold Prices & Appraisal" },
  { to: howToPawn.path, label: "How to Pawn (Paano Mag-Sangla)" },
  { to: karatGuide.path, label: "Gold Karat Guide (18K · 21K · 24K)" },
  { to: interestRates.path, label: "Interest Rates, Patubo & Tubos" },
];
