// user-frontend/src/pages/Pawn-Service-User-Page.js
import React, { useEffect, useLayoutEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  FaComments,
  FaArrowRight,
  FaRegIdCard,
  FaBalanceScale,
  FaClipboardCheck,
  FaMoneyBillAlt,
  FaInfoCircle,
  FaShieldAlt,
  FaExclamationTriangle,
  FaCalculator,
} from "react-icons/fa";
import Footer from "../components/Footer-User-Component";
import Seo, { SITE_ORIGIN } from "../components/Seo";
import "./Pawn-Service-User-Page.css";

// ===========================================================================
// STRUCTURED DATA (module scope) — Service + FAQPage. The FAQ answers mirror
// visible on-page content (Google requires FAQ markup to match the page). The
// Service provider references the homepage LocalBusiness node by @id.
// ===========================================================================
const PAWN_SERVICE_JSONLD = {
  "@type": "Service",
  "@id": `${SITE_ORIGIN}/pawning#service`,
  name: "Pawn Loans (Sangla) on Gold & Jewelry",
  serviceType: "Pawnbroker",
  description:
    "Pawn (sangla) your gold and jewelry for instant cash with low interest, easy renewal and redemption. BSP-regulated and AMLA-compliant.",
  provider: { "@id": `${SITE_ORIGIN}/#business` },
  areaServed: { "@type": "Country", name: "Philippines" },
  url: `${SITE_ORIGIN}/pawning`,
};

const PAWN_FAQ_JSONLD = {
  "@type": "FAQPage",
  "@id": `${SITE_ORIGIN}/pawning#faq`,
  mainEntity: [
    {
      "@type": "Question",
      name: "What do I need to pawn my gold?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Bring your gold jewelry and one valid government-issued ID to any Magis branch. We accept every karat from 10K to 24K and appraise the karat, weight, and condition to determine a fair loan value.",
      },
    },
    {
      "@type": "Question",
      name: "How do I renew my pawn?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Visit any Magis branch on or before the maturity date, present your original pawn ticket and a valid ID, and pay the charges printed on your ticket to extend your term.",
      },
    },
    {
      "@type": "Question",
      name: "How do I redeem my item?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Present your original pawn ticket and a valid ID, then pay the principal plus the charges due. Authorized representatives also need an authorization letter.",
      },
    },
    {
      "@type": "Question",
      name: "What happens to unredeemed items?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unredeemed items may be auctioned following BSP rules and notices after the loan term and grace period lapse.",
      },
    },
  ],
};

// Format today's date as YYYY-MM-DD in the user's local timezone
const todayLocal = () => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

function Pawning() {
  // ===== Sample Interest Calculator State & Logic =====
  const [principal, setPrincipal] = useState("");
  // SEO prerender hydration safety: "today" differs between the build-time
  // snapshot and the visit, so the date starts empty and fills in a
  // useLayoutEffect (pre-paint — users still always see today's date).
  const [pawnDate, setPawnDate] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  useLayoutEffect(() => {
    setPawnDate(todayLocal());
  }, []);
  const [mode, setMode] = useState("renew"); // "renew" or "redeem"
  const [daysElapsed, setDaysElapsed] = useState(0);
  const [interestRate, setInterestRate] = useState(null);
  const [interestAmount, setInterestAmount] = useState(0);
  const [calcError, setCalcError] = useState("");

  const getRateFromDays = (d) => {
    if (d <= 10) return 1.0;
    if (d <= 20) return 1.5;
    if (d <= 30) return 3.0;
    if (d <= 60) return 8.5;
    if (d <= 90) return 14.5;
    if (d <= 120) return 21.5;
    if (d <= 150) return 28.5;
    return 35.5; // 6th month and beyond
  };

  useEffect(() => {
    setCalcError("");
    setInterestRate(null);
    setInterestAmount(0);
    setDaysElapsed(0);

    const p = Number(principal);
    if (!pawnDate || !paymentDate || !p || p <= 0) return;

    const start = new Date(pawnDate);
    const end = new Date(paymentDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return;

    // if paymentDate before pawnDate → show error
    if (end < start) {
      setCalcError("Planned payment date cannot be earlier than the pawn date.");
      return;
    }

    // compute whole days (round up to next full day)
    const diffMs = end.getTime() - start.getTime();
    const d = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    setDaysElapsed(d);

    const rate = getRateFromDays(d);
    setInterestRate(rate);
    setInterestAmount((p * rate) / 100);
  }, [principal, pawnDate, paymentDate]);

  const totalPayable = Number(principal || 0) + interestAmount;
  const displayAmount = mode === "renew" ? interestAmount : totalPayable;

  const peso = (n) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="pawn-page flex flex-col min-h-screen">
      <Seo
        title="Pawn Gold & Jewelry (Sangla) | Magis Gold & Gems"
        description="Pawn (sangla) your gold and jewelry for instant cash — see how much you can pawn 18k/21k gold for, with low interest, easy renewal and redemption. BSP-regulated."
        path="/pawning"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Pawning", path: "/pawning" },
        ]}
        jsonLd={[PAWN_SERVICE_JSONLD, PAWN_FAQ_JSONLD]}
      />

      {/* Hero */}
      <section className="pawn-hero">
        <div className="pawn-shell pawn-hero__inner">
          <p className="pawn-eyebrow">Sangla / Pawn loans</p>
          <h1 className="pawn-hero__title">Pawn your gold with confidence.</h1>
          <p className="pawn-hero__sub">
            Quick, fair cash for your gold jewelry — often in minutes, with clear
            terms and a private, secure experience.
          </p>
          <div className="pawn-cta-row">
            <Link to="/branches" className="pawn-cta">
              <FaComments aria-hidden="true" /> Chat with a Branch{" "}
              <FaArrowRight aria-hidden="true" />
            </Link>
            <Link to="/faqs" className="pawn-cta pawn-cta--ghost">
              View FAQs <FaArrowRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <main className="flex-1">
        {/* SECTION 1: How to Pawn */}
        <section id="how-to-pawn" className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">How to pawn</p>
              <h2 className="pawn-h2">A simple, transparent process.</h2>
              <p className="pawn-lead">
                Secure and straightforward — get fair cash for your gold in just a few steps.
              </p>
            </div>

            <div className="pawn-cell-grid">
              {[
                {
                  icon: <FaRegIdCard aria-hidden="true" />,
                  num: "STEP 1",
                  title: "Bring your item",
                  text: "Visit any branch with your gold jewelry and one valid government-issued ID.",
                },
                {
                  icon: <FaBalanceScale aria-hidden="true" />,
                  num: "STEP 2",
                  title: "Appraisal",
                  text: "We assess karat, weight, and condition to determine a fair loan value.",
                },
                {
                  icon: <FaClipboardCheck aria-hidden="true" />,
                  num: "STEP 3",
                  title: "Offer & ticket",
                  text: "Review the charges and terms. If accepted, sign your ticket and receive cash.",
                },
                {
                  icon: <FaMoneyBillAlt aria-hidden="true" />,
                  num: "STEP 4",
                  title: "Secure storage",
                  text: "We store your item safely until you redeem or renew, under BSP standards.",
                },
              ].map((step, i) => (
                <div key={i} className="pawn-cell">
                  <span className="pawn-cell__icon">{step.icon}</span>
                  <span className="pawn-cell__num">{step.num}</span>
                  <h3 className="pawn-cell__title">{step.title}</h3>
                  <p className="pawn-cell__text">{step.text}</p>
                </div>
              ))}
            </div>

            <div className="pawn-note">
              <FaShieldAlt aria-hidden="true" />
              <p>
                <strong>Your peace of mind:</strong> Every item is appraised by trained staff,
                recorded on an official pawn ticket, and kept in secure storage until you redeem it.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 2: Accepted Items */}
        <section id="accepted-items" className="pawn-section pawn-section--navy">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Accepted items</p>
              <h2 className="pawn-h2">What we appraise and accept.</h2>
              <p className="pawn-lead">
                We accept a wide range of gold jewelry for appraisal and pawning.
              </p>
            </div>

            <div className="pawn-cell-grid">
              <div className="pawn-cell">
                <span className="pawn-cell__icon"><FaMoneyBillAlt aria-hidden="true" /></span>
                <h3 className="pawn-cell__title">Gold jewelry</h3>
                <p className="pawn-cell__text">
                  Rings, necklaces, bracelets, earrings, pendants — every karat from 10K to 24K, appraised by karat and weight.
                </p>
              </div>
              <div className="pawn-cell">
                <span className="pawn-cell__icon"><FaBalanceScale aria-hidden="true" /></span>
                <h3 className="pawn-cell__title">With stones</h3>
                <p className="pawn-cell__text">
                  Gold jewelry with stones (e.g., diamonds) is carefully evaluated.
                </p>
              </div>
              <div className="pawn-cell">
                <span className="pawn-cell__icon"><FaInfoCircle aria-hidden="true" /></span>
                <h3 className="pawn-cell__title">Ask us</h3>
                <p className="pawn-cell__text">
                  Have something else? Acceptance depends on our appraiser's evaluation at the branch.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 3: How to Renew */}
        <section id="how-to-renew" className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">How to renew</p>
              <h2 className="pawn-h2">Extend your term by paying interest.</h2>
              <p className="pawn-lead">
                Keep your item and push back the maturity date in three quick steps.
              </p>
            </div>

            <div className="pawn-feature pawn-feature--solo">
              <h3 className="pawn-feature__title">Follow these simple steps</h3>
              <ul className="pawn-checklist">
                <li>Visit any Magis branch on or before the maturity date.</li>
                <li>Present your original pawn ticket and a valid ID.</li>
                <li>Pay the charges printed on your ticket to renew your term.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* SECTION 4: How to Redeem */}
        <section id="how-to-redeem" className="pawn-section pawn-section--navy">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">How to redeem</p>
              <h2 className="pawn-h2">Reclaim your jewelry.</h2>
              <p className="pawn-lead">
                Settle the principal and charges due, then take your item home.
              </p>
            </div>

            <div className="pawn-feature-grid">
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Requirements</h3>
                <ul className="pawn-checklist">
                  <li>Original pawn ticket.</li>
                  <li>Valid ID of the pawner or representative.</li>
                  <li>Payment of principal plus charges due.</li>
                </ul>
              </div>
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Reminders</h3>
                <ul className="pawn-checklist">
                  <li className="is-warn">
                    Representatives need an authorization letter, valid ID, and the original pawn ticket.
                  </li>
                  <li className="is-warn">
                    After verification, your item is released along with your redeemed ticket.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 5: Sample Interest Calculator */}
        <section id="interest-calculator" className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Interest calculator</p>
              <h2 className="pawn-h2">Estimate your charges.</h2>
              <p className="pawn-lead">
                For planning only — actual rates vary per branch and appear on your pawn ticket.
              </p>
            </div>

            <div className="pawn-calc">
              <div className="pawn-calc__modes" role="tablist" aria-label="Calculation mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "renew"}
                  onClick={() => setMode("renew")}
                  className={`pawn-calc__mode ${mode === "renew" ? "is-active" : ""}`}
                >
                  Renew (interest only)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "redeem"}
                  onClick={() => setMode("redeem")}
                  className={`pawn-calc__mode ${mode === "redeem" ? "is-active" : ""}`}
                >
                  Redeem (principal + interest)
                </button>
              </div>

              <div className="pawn-calc__inputs">
                <div className="pawn-field">
                  <label htmlFor="principal">Principal amount (₱)</label>
                  <input
                    type="number"
                    id="principal"
                    min="0"
                    placeholder="Enter amount"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                  />
                </div>
                <div className="pawn-field">
                  <label htmlFor="pawnDate">Pawn date</label>
                  <input
                    type="date"
                    id="pawnDate"
                    value={pawnDate}
                    onChange={(e) => setPawnDate(e.target.value)}
                  />
                </div>
                <div className="pawn-field">
                  <label htmlFor="paymentDate">Planned payment date</label>
                  <input
                    type="date"
                    id="paymentDate"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="pawn-calc__result" aria-live="polite">
                {!principal || !pawnDate || !paymentDate ? (
                  <div className="pawn-result-empty">
                    <FaCalculator aria-hidden="true" />
                    <p>Fill in the three fields above — your estimate appears here instantly.</p>
                  </div>
                ) : calcError ? (
                  <p className="pawn-result-error">{calcError}</p>
                ) : (
                  <div className="pawn-result">
                    <p className="pawn-result__label">
                      {mode === "redeem" ? "Total to redeem" : "Estimated to renew"}
                    </p>
                    <span className="pawn-result__amount">
                      <span className="pawn-result__cur">₱</span>
                      {peso(displayAmount)}
                    </span>
                    <p className="pawn-result__sub">
                      {mode === "redeem"
                        ? "Principal + interest — pay in full to reclaim your item."
                        : "Interest only — pay this to extend your pawn term."}
                    </p>

                    <div className="pawn-stats">
                      <div className="pawn-stat">
                        <span className="pawn-stat__label">Days elapsed</span>
                        <span className="pawn-stat__value">
                          {daysElapsed} day{daysElapsed === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="pawn-stat">
                        <span className="pawn-stat__label">Interest rate</span>
                        <span className="pawn-stat__value">{interestRate?.toFixed(1)}%</span>
                      </div>
                      <div className="pawn-stat">
                        <span className="pawn-stat__label">Est. interest</span>
                        <span className="pawn-stat__value">₱{peso(interestAmount)}</span>
                      </div>
                      <div className="pawn-stat">
                        <span className="pawn-stat__label">Principal</span>
                        <span className="pawn-stat__value">₱{peso(Number(principal || 0))}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <p className="pawn-calc__note">
                *For sample estimation only. Actual rates, maturity, and grace periods vary per branch.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 6: Terms & Conditions */}
        <section id="terms-and-conditions" className="pawn-section pawn-section--navy">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Terms &amp; conditions</p>
              <h2 className="pawn-h2">Fair terms, clearly explained.</h2>
              <p className="pawn-lead">A simple summary of how your pawn works — from your ticket to the day you redeem.</p>
            </div>

            <div className="pawn-feature-grid">
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Your transaction</h3>
                <ul className="pawn-checklist">
                  <li>
                    <strong>Charges &amp; periods:</strong> Exact interest, charges, and grace
                    periods are printed on your pawn ticket.
                  </li>
                  <li>
                    <strong>Ticket is your contract:</strong> Keep it safe — it's required for
                    renewals and redemption.
                  </li>
                  <li>
                    <strong>KYC / AMLA:</strong> Valid ID and documentation are required to comply with AMLA.
                  </li>
                  <li>
                    <strong>BSP-regulated:</strong> We strictly follow Bangko Sentral ng Pilipinas regulations.
                  </li>
                </ul>
              </div>
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Redemption &amp; care</h3>
                <ul className="pawn-checklist">
                  <li>
                    <strong>Redemption &amp; renewals:</strong> Only the pawner or an authorized
                    representative may redeem.
                  </li>
                  <li>
                    <strong>Unredeemed items:</strong> May be auctioned following BSP rules and notices.
                  </li>
                  <li>
                    <strong>Care &amp; liability:</strong> Items are stored securely per industry standards.
                  </li>
                  <li>
                    <strong>Privacy:</strong> See our{" "}
                    <Link to="/privacy-policy" className="pawn-link">Privacy Policy</Link>{" "}
                    for how your data is handled.
                  </li>
                </ul>
              </div>
            </div>

            <div className="pawn-note">
              <FaExclamationTriangle aria-hidden="true" />
              <p>
                This summary is for convenience only. The <strong>pawn ticket</strong> and
                applicable laws prevail. For complete terms, visit{" "}
                <Link to="/terms" className="pawn-link">Terms &amp; Conditions</Link>.
              </p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Get started</p>
              <h2 className="pawn-h2">Visit us for a free appraisal.</h2>
              <p className="pawn-lead">
                Our appraisers evaluate your jewelry and walk you through all charges and terms
                clearly — no pressure, no obligation.
              </p>
            </div>
            <div className="pawn-cta-row">
              <Link to="/branches" className="pawn-cta">
                <FaComments aria-hidden="true" /> Chat with a Branch{" "}
                <FaArrowRight aria-hidden="true" />
              </Link>
              <Link to="/faqs" className="pawn-cta pawn-cta--ghost">
                Read FAQs <FaArrowRight aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Global footer */}
      <Footer />
    </div>
  );
}

export default Pawning;
