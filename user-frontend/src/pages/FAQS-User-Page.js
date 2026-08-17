import React, { useState } from "react";
import Footer from "../components/Footer-User-Component";
import { Link } from "react-router-dom";
import Seo from "../components/Seo";
import "./FAQS-User-Page.css";

// Single source of truth for the FAQ content. The visible JSX below AND the
// FAQPage JSON-LD (for Google rich results) are both rendered from these arrays,
// so the structured data can never drift from what users actually read.
const COMPANY_FAQS = [
  {
    q: "What is pawning, and what is “sangla”?",
    a: "Pawning (sangla) is a quick, collateral-based loan: you leave an item as security, get cash, and reclaim it (tubos) once you pay back the amount due. At Magis we lend against gold jewelry, with no credit check and no lengthy paperwork.",
  },
  {
    q: "How do I pawn my gold jewelry? (Paano mag-sangla ng alahas?)",
    a: "Visit any Magis branch with your gold jewelry and one valid government ID. We appraise it for free, on the spot, explain the offer, and—if you accept—release your cash together with a pawn ticket. The process usually takes only a few minutes.",
  },
  {
    q: "How much can I pawn my gold for? (Magkano ang pwedeng isangla ng ginto?)",
    a: "Your loan is based on the piece’s purity (karat) and weight, valued at our posted appraisal rates—so higher-karat (18k, 21k, 22k) and heavier items appraise higher. We accept every karat from 10k to 24k—lower-karat pieces simply appraise at a lower per-gram value. Our rates are set below the prevailing gold market price so we can keep serving you sustainably; they are not a spot-market quote. Appraisal is free and on the spot, and the appraiser shows the amount before you decide.",
  },
  {
    q: "What is your interest rate? (Magkano ang patubo/interest?)",
    a: "Interest is as low as 1% per month on select branches. The exact rate and any charges are posted in-branch and disclosed before you proceed, and the final computation is printed on your pawn ticket.",
  },
  {
    q: "What do “tubos” and “patubo” mean?",
    a: "“Tubos” means redeeming—reclaiming your item by paying the amount due. “Patubo” is the interest on the loan. You can also renew by paying the interest to extend your loan to a new maturity date.",
  },
  {
    cat: "jewelry",
    q: "Do you offer jewelry layaway (hulugan)?",
    a: "Yes—you can reserve gold jewelry and pay in installments (hulugan). See our Jewelry Sales page for details and a layaway calculator that estimates your payments.",
  },
  {
    q: "Do I need to go to a branch to pawn an item?",
    a: "Yes. The website and live chat are for inquiries only. Actual pawning requires in-branch appraisal, a valid ID, and issuance of a pawn ticket.",
  },
  {
    q: "What is a pawn ticket and why is it important?",
    a: "It’s the official document for your loan—showing the item, amount, charges, and due dates. Keep it safe; you’ll need it to redeem or renew.",
  },
  {
    q: "What items can I pawn? Do you accept gadgets or appliances?",
    a: "We specialize in gold jewelry only (every karat from 10k to 24k)—we do not accept gadgets, cellphones, appliances, or vehicles. Acceptance still depends on authenticity, condition, and branch policy; we cannot accept stolen, counterfeit, or illegal items.",
  },
  {
    q: "How is my gold appraised? Is appraisal free?",
    a: "Appraisal is free and on the spot, based on authenticity, weight, and karat (purity) at our posted appraisal rates (set below the prevailing gold market price). The appraiser explains the offer before you decide.",
  },
  {
    q: "What ID do I need to pawn? (Anong valid ID ang tinatanggap?)",
    a: "Any one (1) valid government-issued ID—for example: PhilID/National ID, Passport, Driver’s License, UMID, PRC, SSS, GSIS, Postal ID, Voter’s ID, PhilHealth, TIN, Pag-IBIG, Senior Citizen or PWD ID, NBI or Police Clearance, or a Barangay Certification with photo and signature, among others. Some transactions may require additional documents for regulatory (AMLA) checks.",
  },
  {
    q: "How is interest computed?",
    a: "Rates are posted in-branch and disclosed before you proceed. Your pawn ticket shows the final computation for the chosen term.",
  },
  {
    q: "What is the loan term and when is the due date?",
    a: "Your maturity date is on the pawn ticket. Redeem or renew on/before that date (any grace arrangements will be stated on your ticket or in-branch notices).",
  },
  {
    q: "Can I renew my loan?",
    a: "Yes, if done within the allowed period. Interest charges will be computed before renewal; a new maturity date will be issued.",
  },
  {
    q: "How do I redeem my item?",
    a: "Bring your pawn ticket, a valid ID, and the amount due shown on your ticket (principal plus interest). We’ll process the release at the branch.",
  },
  {
    q: "What if I lose my pawn ticket?",
    a: "Visit the branch with a valid ID. You may need an Affidavit of Loss and to pay a replacement/processing fee. Security checks will apply.",
  },
  {
    q: "What happens if I don’t redeem on time?",
    a: "After the allowed period, the item may be disposed of/auctioned in line with policy and regulations. Details are on your pawn ticket and in-branch notices.",
  },
  {
    q: "How do you keep my item safe?",
    a: "Items are kept with reasonable care and secure storage. Liability is limited as permitted by law—please review the ticket terms.",
  },
  {
    cat: "policies",
    q: "Do you accept minors as customers?",
    a: "Pawn transactions are generally for customers of legal age. Minors typically require a parent/guardian and proper documentation (branch discretion).",
  },
  {
    cat: "policies",
    q: "Is the live chat binding for a pawn transaction?",
    a: "No. Chat is for assistance only. Official records are branch-issued documents and your pawn ticket.",
  },
  {
    q: "Can I get a statement of charges before I decide?",
    a: "Yes. We can show a clear breakdown before you accept; the pawn ticket reflects the final terms.",
  },
  {
    cat: "policies",
    q: "Do you provide reminders for due dates?",
    a: "We may send courtesy reminders (thru SMS) when possible, but tracking your due date remains your responsibility.",
  },
  {
    cat: "policies",
    q: "What if my contact details change?",
    a: "Update them with our branch staff or customer support so notices and records remain accurate.",
  },
  {
    cat: "jewelry",
    q: "Do you buy items outright?",
    a: "This depends on branch policy. Please ask the branch for availability and terms.",
  },
  {
    cat: "policies",
    q: "How is my personal information protected?",
    a: "We follow the Data Privacy Act (RA 10173). We collect only what’s needed, secure it, and keep it only as long as necessary. You can exercise your data rights through our DPO.",
  },
  {
    cat: "policies",
    q: "Do you use cookies or collect device data on the website?",
    a: "We use cookies to run the site, remember preferences, and improve performance. You can manage cookies in your browser; some features may be affected if disabled.",
  },
  {
    cat: "policies",
    q: "How do I file a concern or complaint?",
    a: "Start with our branch staff or customer support. If unresolved, you may elevate to BSP Consumer Assistance. For privacy concerns, you may contact the National Privacy Commission (NPC).",
  },
  {
    cat: "policies",
    q: "Where can I read the full terms and privacy policy?",
    a: "On our website’s Terms & Conditions and Privacy Policy pages, in-branch notices, and on your pawn ticket.",
  },
];

const REGULATORY_FAQS = [
  {
    q: "Is Magis a registered pawnshop? Is it legit and safe? (Legit ba?)",
    a: "Yes. Magis Gold & Gems is a registered pawnshop supervised by the Bangko Sentral ng Pilipinas (BSP) and compliant with Anti-Money Laundering Council (AMLC) rules. Every transaction is documented with an official pawn ticket for your protection.",
  },
  {
    q: "Who regulates pawnshops in the Philippines? (BSP)",
    a: "Pawnshops are supervised by the Bangko Sentral ng Pilipinas (BSP), which issues rules on licensing, disclosures, reporting, and consumer protection. Magis is registered with and supervised by the BSP and complies with AMLC requirements.",
  },
  {
    q: "What is AMLA and why does it matter to me?",
    a: "The Anti-Money Laundering Act (AMLA) requires identity verification (KYC) and other controls to help prevent financial crimes. You may be asked for valid ID and supporting documents.",
  },
  {
    q: "Will my transaction be reported under AMLA?",
    a: "Certain transactions may be monitored or reported as required by law. This is a legal obligation and is handled confidentially.",
  },
];

// Flat, categorized list driving both the visible accordions and the pill
// filter. COMPANY_FAQS items default to "pawning" (the dominant topic) so only
// exceptions carry an explicit `cat`; REGULATORY_FAQS are all "regulation".
const ALL_FAQS = [
  ...COMPANY_FAQS.map((item) => ({ cat: "pawning", ...item })),
  ...REGULATORY_FAQS.map((item) => ({ ...item, cat: "regulation" })),
];

const FAQ_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "pawning", label: "Pawning (Sangla)" },
  { id: "jewelry", label: "Jewelry & Layaway" },
  { id: "policies", label: "Policies & Privacy" },
  { id: "regulation", label: "BSP & AMLA" },
];

const FAQ_SCHEMA = {
  "@type": "FAQPage",
  // Always the FULL list — the visible filter must not shrink the rich result.
  mainEntity: ALL_FAQS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

function FAQsUserPage() {
  // Real content-revision date (was new Date() — which dishonestly showed every
  // visitor "today" AND breaks prerender hydration). Bump when FAQs change.
  const lastUpdated = "June 20, 2026";

  // Category filter. Defaults to "all", so the first client render matches the
  // prerendered HTML exactly (hydration-safe); filtering happens only after an
  // explicit pill click.
  const [activeCat, setActiveCat] = useState("all");
  const visibleFaqs =
    activeCat === "all" ? ALL_FAQS : ALL_FAQS.filter((item) => item.cat === activeCat);

  return (
    <div className="flex flex-col min-h-screen">
      <Seo
        title="FAQs: Pawning & Sangla | Magis Gold & Gems"
        description="Answers on how to pawn (paano mag-sangla), requirements, how much you can pawn gold for, interest, redemption (tubos), appraisal, and BSP/AMLA rules."
        path="/faqs"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "FAQs", path: "/faqs" },
        ]}
        jsonLd={FAQ_SCHEMA}
      />
      {/* Main — hero INSIDE the landmark (axe region rule). */}
      <main className="flex-grow">
        {/* Hero — gradient-only. The old background-image pointed at
            /images/hero.jpg, which never existed (silent 404 on every visit);
            the overlay below is what users actually saw, so rendering is
            unchanged. Drop a real photo back in here when one is available. */}
        <section className="relative h-72 md:h-80">
          <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e]/90 via-[#1a1a2e]/80 to-[#2d2d42]/85" />
          <div className="relative z-10 flex h-full flex-col items-center justify-center px-4 text-center text-white">
            <h1 className="mb-3 text-3xl font-extrabold tracking-tight md:text-5xl">
              Frequently Asked Questions
            </h1>
            <p className="text-sm text-gray-300 md:text-base">Reviewed {lastUpdated}</p>
          </div>
        </section>

        {/* Intro */}
        <section className="bg-white py-10">
          <div className="container mx-auto max-w-4xl px-4">
            <p className="text-base leading-relaxed text-gray-600">
              Mabilisang sagot ito sa mga tanong tungkol sa serbisyo namin at sa mga
              pangkalahatang patakaran ng mga pawnshop sa Pilipinas. Hindi nito pinapalitan ang
              nakasulat sa pawn ticket mo o ang kumpletong Terms &amp; Conditions at Privacy
              Policy na nakalathala sa site na ito.
            </p>
          </div>
        </section>

        {/* FAQs — one list, filterable by topic pills */}
        <section className="bg-[#faf8f5] py-12">
          <div className="container mx-auto max-w-4xl px-4">
            <h2 className="mb-6 text-2xl font-extrabold tracking-tight text-[#1a1a2e] md:text-3xl">
              Mga Tanong at Sagot
            </h2>
            <div className="faq-filter-bar" role="group" aria-label="Filter FAQs by topic">
              {FAQ_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`faq-pill${activeCat === cat.id ? " faq-pill--active" : ""}`}
                  aria-pressed={activeCat === cat.id}
                  onClick={() => setActiveCat(cat.id)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            <div>
              {visibleFaqs.map((item, index) => (
                <details key={item.q} className="faq-accordion">
                  <summary>
                    <h3>{index + 1}. {item.q}</h3>
                  </summary>
                  <p className="faq-answer">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTAs */}
        <section className="bg-[#faf8f5] py-12">
          <div className="container mx-auto max-w-4xl px-4 text-center">
            <p className="mb-6 text-gray-600">
              May tanong ka pa? Check ang policies namin o i-message lang kami.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/terms"
                className="rounded-full bg-[#1a1a2e] px-6 py-3 font-semibold text-[#d4a853] transition hover:bg-[#2d2d42]"
              >
                Terms &amp; Conditions
              </Link>
              <Link
                to="/privacy-policy"
                className="rounded-full bg-gradient-to-br from-[#d4a853] to-[#c9a227] px-6 py-3 font-semibold text-[#1a1a2e] transition hover:brightness-95"
              >
                Privacy Policy
              </Link>
              <Link
                to="/contact-us"
                className="rounded-full border border-[#d4a853]/40 bg-white px-6 py-3 font-semibold text-[#1a1a2e] transition hover:bg-[#d4a853]/10"
              >
                Contact Us
              </Link>
              <Link
                to="/branches"
                className="rounded-full border border-[#d4a853]/40 bg-white px-6 py-3 font-semibold text-[#1a1a2e] transition hover:bg-[#d4a853]/10"
              >
                Hanapin ang Branch
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default FAQsUserPage;
