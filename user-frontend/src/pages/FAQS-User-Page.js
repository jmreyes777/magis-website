import React from "react";
import Footer from "../components/Footer-User-Component";
import { Link } from "react-router-dom";
import Seo from "../components/Seo";

// Single source of truth for the FAQ content. The visible JSX below AND the
// FAQPage JSON-LD (for Google rich results) are both rendered from these arrays,
// so the structured data can never drift from what users actually read.
const COMPANY_FAQS = [
  {
    q: "Do I need to go to a branch to pawn an item?",
    a: "Yes. The website and live chat are for inquiries only. Actual pawning requires in-branch appraisal, a valid ID, and issuance of a pawn ticket.",
  },
  {
    q: "What is a pawn ticket and why is it important?",
    a: "It’s the official document for your loan—showing the item, amount, charges, and due dates. Keep it safe; you’ll need it to redeem or renew.",
  },
  {
    q: "What items can I pawn?",
    a: "We only accept Gold Jewelry. Acceptance depends on condition and branch policy. We cannot accept stolen, counterfeit, illegal, or restricted items.",
  },
  {
    q: "How do you appraise my item?",
    a: "By authenticity, condition, and weight/karat. The appraiser explains the offer before you decide.",
  },
  {
    q: "What IDs do I need?",
    a: "A valid government-issued ID. For some transactions, additional documents may be required to meet regulatory checks.",
  },
  {
    q: "How are interest and fees computed?",
    a: "Rates/fees are posted in-branch and disclosed before you proceed. Your pawn ticket shows the final computation for the chosen term.",
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
    a: "Bring your pawn ticket, a valid ID, and the amount due (principal, interest, applicable fees). We’ll process the release at the branch.",
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
    q: "Do you accept minors as customers?",
    a: "Pawn transactions are generally for customers of legal age. Minors typically require a parent/guardian and proper documentation (branch discretion).",
  },
  {
    q: "Is the live chat binding for a pawn transaction?",
    a: "No. Chat is for assistance only. Official records are branch-issued documents and your pawn ticket.",
  },
  {
    q: "Can I get a statement of charges before I decide?",
    a: "Yes. We can show a clear breakdown before you accept; the pawn ticket reflects the final terms.",
  },
  {
    q: "Do you provide reminders for due dates?",
    a: "We may send courtesy reminders (thru SMS) when possible, but tracking your due date remains your responsibility.",
  },
  {
    q: "What if my contact details change?",
    a: "Update them with our branch staff or customer support so notices and records remain accurate.",
  },
  {
    q: "Do you buy items outright?",
    a: "This depends on branch policy. Please ask the branch for availability and terms.",
  },
  {
    q: "How is my personal information protected?",
    a: "We follow the Data Privacy Act (RA 10173). We collect only what’s needed, secure it, and keep it only as long as necessary. You can exercise your data rights through our DPO.",
  },
  {
    q: "Do you use cookies or collect device data on the website?",
    a: "We use cookies to run the site, remember preferences, and improve performance. You can manage cookies in your browser; some features may be affected if disabled.",
  },
  {
    q: "How do I file a concern or complaint?",
    a: "Start with our branch staff or customer support. If unresolved, you may elevate to BSP Consumer Assistance. For privacy concerns, you may contact the National Privacy Commission (NPC).",
  },
  {
    q: "Where can I read the full terms and privacy policy?",
    a: "On our website’s Terms & Conditions and Privacy Policy pages, in-branch notices, and on your pawn ticket.",
  },
];

const REGULATORY_FAQS = [
  {
    q: "Who regulates pawnshops in the Philippines? (BSP)",
    a: "Pawnshops are supervised by the Bangko Sentral ng Pilipinas (BSP), which issues rules on licensing, disclosures, reporting, and consumer protection.",
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

const FAQ_SCHEMA = {
  "@type": "FAQPage",
  mainEntity: [...COMPANY_FAQS, ...REGULATORY_FAQS].map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

function FAQsUserPage() {
  const lastUpdated = new Date().toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex flex-col min-h-screen">
      <Seo
        title="FAQs | Magis Gold & Gems Pawnshop"
        description="Answers about pawning, pawn tickets, appraisal, IDs, redemption, renewal, fees, and Philippine pawnshop regulations (BSP, AMLA)."
        path="/faqs"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "FAQs", path: "/faqs" },
        ]}
        jsonLd={FAQ_SCHEMA}
      />
      {/* Hero */}
      <section
        className="relative h-64 bg-cover bg-center"
        style={{ backgroundImage: "url('/images/hero.jpg')" }}
      >
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative z-10 flex flex-col items-center justify-center h-full text-center px-4 text-white">
          <h1 className="text-3xl md:text-4xl font-bold mb-2">Frequently Asked Questions</h1>
          <p className="text-sm md:text-base opacity-90">Reviewed on {lastUpdated}</p>
        </div>
      </section>

      {/* Main */}
      <main className="flex-grow">
        {/* Intro */}
        <section className="py-10 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <p className="text-sm text-gray-700">
              These FAQs provide quick answers about our services and general rules for pawnshops in
              the Philippines. They do not replace the specific terms on your pawn ticket or the full
              Terms & Conditions and Privacy Policy published on this site.
            </p>
          </div>
        </section>

        {/* Company FAQs */}
        <section className="py-6 bg-gray-50">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-xl font-semibold mb-4 text-gray-900">Company FAQs</h2>
            <div className="space-y-5 text-gray-800">
              {COMPANY_FAQS.map((item, index) => (
                <div key={item.q}>
                  <h3 className="font-semibold">{index + 1}. {item.q}</h3>
                  <p className="text-sm">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Regulatory / Industry FAQs */}
        <section className="py-6 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-xl font-semibold mb-4 text-gray-900">Regulatory / Industry FAQs</h2>
            <div className="space-y-5 text-gray-800">
              {REGULATORY_FAQS.map((item, index) => (
                <div key={item.q}>
                  <h3 className="font-semibold">{COMPANY_FAQS.length + index + 1}. {item.q}</h3>
                  <p className="text-sm">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTAs */}
        <section className="py-10 bg-gray-50">
          <div className="container mx-auto px-4 max-w-4xl text-center">
            <p className="text-gray-700 mb-6">
              Need more help? View our policies or contact us.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/terms"
                className="px-6 py-2 rounded-full bg-black text-yellow-500 font-semibold hover:bg-gray-800 transition"
              >
                Terms &amp; Conditions
              </Link>
              <Link
                to="/privacy-policy"
                className="px-6 py-2 rounded-full bg-yellow-500 text-black font-semibold hover:bg-yellow-600 transition"
              >
                Privacy Policy
              </Link>
              <Link
                to="/contact-us"
                className="px-6 py-2 rounded-full bg-white border font-semibold hover:bg-gray-100 transition"
              >
                Contact Us
              </Link>
              <Link
                to="/branches"
                className="px-6 py-2 rounded-full bg-white border font-semibold hover:bg-gray-100 transition"
              >
                Find a Branch
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
