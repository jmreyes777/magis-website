// user-frontend/src/pages/Pawning-User-Page.js
import React, { useEffect, useState } from "react";
import Footer from "../components/Footer-User-Component";
import Seo from "../components/Seo";
import { Link, useLocation } from "react-router-dom";
import {
  FaBoxOpen,
  FaBalanceScale,
  FaClipboardCheck,
  FaMoneyBillAlt,
  FaRegIdCard,
  FaGavel,
  FaUndo,
  FaSearchLocation,
  FaArrowRight,
  FaShieldAlt,
  FaCheckCircle,
  FaExclamationTriangle,
  FaInfoCircle,
  FaCalculator,
} from "react-icons/fa";
import "./Pawn-Service-User-Page.css";

function Pawning() {
  // Simple in-page quick-nav config (anchors)
  const location = useLocation();
  const sections = [
    { id: "how-to-pawn", label: "How to Pawn" },
    { id: "accepted-items", label: "Accepted Items" },
    { id: "how-to-renew", label: "How to Renew" },
    { id: "how-to-redeem", label: "How to Redeem" },
    { id: "interest-calculator", label: "Interest Calculator" },
    { id: "terms-and-conditions", label: "Terms & Conditions" },
  ];

  // Format today's date as YYYY-MM-DD in the user's local timezone
const todayLocal = () => {
  const d = new Date();
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day   = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

  // ===== Sample Interest Calculator State & Logic =====
  const [principal, setPrincipal] = useState("");
  const [pawnDate, setPawnDate] = useState(() => todayLocal());
  const [paymentDate, setPaymentDate] = useState("");
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
      setCalcError("⚠️ Planned payment date cannot be earlier than the pawn date.");
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

  return (
    <div className="flex flex-col min-h-screen bg-gray-50 text-gray-800">
      <Seo
        title="Pawning | Magis Gold & Gems"
        description="How to pawn, accepted items, renewal and redemption steps, and key terms & conditions. BSP-regulated and AMLA-compliant."
        path="/pawning"
      />

      <main className="flex-1">
        {/* Hero */}
        <section className="pawn-hero">
          <div className="pawn-hero-content">
            <h1 className="pawn-hero-title">
              Pawn Your Gold with Confidence
            </h1>
            <p className="pawn-hero-subtitle">
              Fast processing, transparent charges, and secure handling of your jewelry.
              We operate under BSP rules and AMLA compliance for your peace of mind.
            </p>
            <div className="pawn-hero-cta-container">
              <Link
                to="/branches"
                className="btn-primary-cta"
              >
                Find a Branch <FaSearchLocation className="ml-2" />
              </Link>
              <Link
                to="/faqs"
                className="btn-secondary-cta"
              >
                FAQs <FaArrowRight className="ml-2" />
              </Link>
            </div>
          </div>
        </section>
        {/* SECTION 1: How to Pawn */}
        <section id="how-to-pawn" className="pawn-section">
          <div className="pawn-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaBoxOpen className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="pawn-section-title">How to Pawn</h2>
            </div>
            <p className="pawn-section-subtitle">
              Simple, secure, and transparent process to get cash for your gold
            </p>
          </div>

          <div className="pawn-steps-grid">
            {[
              {
                icon: <FaRegIdCard />,
                title: "1) Bring Your Item",
                text: "Visit any branch with your gold jewelry and one valid government-issued ID.",
              },
              {
                icon: <FaBalanceScale />,
                title: "2) Appraisal",
                text: "We assess karat, weight, and condition to determine a fair loan value.",
              },
              {
                icon: <FaClipboardCheck />,
                title: "3) Offer & Ticket",
                text: "Review the charges and terms. If accepted, sign your ticket and receive cash.",
              },
              {
                icon: <FaMoneyBillAlt />,
                title: "4) Secure Storage",
                text: "We store your item safely until you redeem or renew, under BSP standards.",
              },
            ].map((step, i) => (
              <div
                key={i}
                className="pawn-step-card"
              >
                <div className="pawn-step-icon">{step.icon}</div>
                <h3 className="pawn-step-title">{step.title}</h3>
                <p className="pawn-step-text">{step.text}</p>
              </div>
            ))}
          </div>

          <div className="pawn-compliance-banner">
            <FaShieldAlt className="pawn-compliance-icon" />
            <p className="pawn-compliance-text">
              <strong>Compliance:</strong> We follow BSP pawnshop regulations and implement
              AMLA Know-Your-Customer (KYC) and record-keeping requirements.
            </p>
          </div>
        </section>

        {/* SECTION 2: Accepted Items */}
        <section id="accepted-items" className="pawn-section pawn-section-alt">
          <div className="pawn-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaGavel className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="pawn-section-title">Accepted Items</h2>
            </div>
            <p className="pawn-section-subtitle">
              We accept various gold jewelry items for appraisal and pawning
            </p>
          </div>

          <div className="pawn-items-grid">
            <div className="pawn-item-card">
              <div className="pawn-item-icon">
                <FaMoneyBillAlt />
              </div>
              <h3 className="pawn-item-title">
                Gold Jewelry
              </h3>
              <p className="pawn-item-text">
                Rings, necklaces, bracelets, earrings, pendants. Appraised by karat and weight.
              </p>
            </div>

            <div className="pawn-item-card">
              <div className="pawn-item-icon">
                <FaBalanceScale />
              </div>
              <h3 className="pawn-item-title">
                With Stones
              </h3>
              <p className="pawn-item-text">
                Gold jewelry with stones (e.g., diamonds) are carefully evaluated.
              </p>
            </div>

            <div className="pawn-item-card">
              <div className="pawn-item-icon">
                <FaInfoCircle />
              </div>
              <h3 className="pawn-item-title">Ask Us</h3>
              <p className="pawn-item-text">
                Have something else? Acceptance depends on our appraiser's evaluation at the branch.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 3: How to Renew */}
        <section id="how-to-renew" className="pawn-section">
          <div className="pawn-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaUndo className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="pawn-section-title">How to Renew</h2>
            </div>
            <p className="pawn-section-subtitle">
              Extend your pawn term by paying the interest charges
            </p>
          </div>

          <div className="pawn-process-container">
            <div className="pawn-process-card">
              <h3 className="pawn-process-title">
                Follow these simple steps:
              </h3>
              <ul className="pawn-process-list">
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>Visit the any Magis branch on or before the maturity date.</span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>Present your original pawn ticket and a valid ID.</span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>Pay the charges printed on your ticket to renew your term.</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* SECTION 4: How to Redeem */}
        <section id="how-to-redeem" className="pawn-section pawn-section-alt">
          <div className="pawn-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaBoxOpen className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="pawn-section-title">How to Redeem</h2>
            </div>
            <p className="pawn-section-subtitle">
              Reclaim your gold jewelry by paying the principal and charges
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-1000 mx-auto">
            <div className="pawn-process-card">
              <h3 className="pawn-process-title">
                Requirements
              </h3>
              <ul className="pawn-process-list">
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>Original pawn ticket.</span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>Valid ID of the pawner or representative.</span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>Payment of principal plus charges due.</span>
                </li>
              </ul>
            </div>

            <div className="pawn-process-card">
              <h3 className="pawn-process-title">Reminders</h3>
              <ul className="pawn-process-list">
                <li>
                  <FaExclamationTriangle className="pawn-warning-icon" />
                  <span>
                    Representatives need an authorization letter, valid ID, and the original pawn ticket.
                  </span>
                </li>
                <li>
                  <FaExclamationTriangle className="pawn-warning-icon" />
                  <span>
                    After verification, your item will be released along with your redeemed ticket.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* SECTION 5: Sample Interest Calculator */}
        <section id="interest-calculator" className="pawn-section">
          <div className="pawn-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaCalculator className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="pawn-section-title">Sample Interest Calculator</h2>
            </div>
            <p className="pawn-section-subtitle">
              Estimate possible renewal or redemption charges for planning only.
              Actual rates vary per branch and appear on your pawn ticket.
            </p>
          </div>

          <div className="pawn-calculator-container">
            {/* Mode selector (buttons) */}
            <div className="pawn-calculator-modes">
              <button
                onClick={() => setMode("renew")}
                className={`pawn-mode-btn ${mode === "renew" ? "active" : "inactive"}`}
              >
                Renew (Interest Only)
              </button>
              <button
                onClick={() => setMode("redeem")}
                className={`pawn-mode-btn ${mode === "redeem" ? "active" : "inactive"}`}
              >
                Redeem (Principal + Interest)
              </button>
            </div>

            {/* Inputs */}
            <div className="pawn-calculator-inputs">
              <div className="pawn-input-group">
                <label
                  htmlFor="principal"
                  className="pawn-input-label"
                >
                  Principal Amount (₱)
                </label>
                <input
                  type="number"
                  id="principal"
                  min="0"
                  placeholder="Enter amount"
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  className="pawn-input-field"
                />
              </div>
              <div className="pawn-input-group">
                <label
                  htmlFor="pawnDate"
                  className="pawn-input-label"
                >
                  Pawn Date
                </label>
                <input
                  type="date"
                  id="pawnDate"
                  value={pawnDate}
                  onChange={(e) => setPawnDate(e.target.value)}
                  className="pawn-input-field"
                />
              </div>
              <div className="pawn-input-group">
                <label
                  htmlFor="paymentDate"
                  className="pawn-input-label"
                >
                  Planned Payment Date
                </label>
                <input
                  type="date"
                  id="paymentDate"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="pawn-input-field"
                />
              </div>
            </div>

            {/* Results */}
            <div className="pawn-calculator-results">
              {!principal || !pawnDate || !paymentDate ? (
                <p className="text-sm text-gray-600 text-center">
                  Please fill in all fields above to calculate.
                </p>
              ) : calcError ? (
                <p className="text-sm text-red-600 text-center">{calcError}</p>
              ) : (
                <div className="pawn-results-grid">
                  <p className="pawn-result-item">
                    <strong>Days Elapsed:</strong> {daysElapsed} day
                    {daysElapsed === 1 ? "" : "s"}
                  </p>
                  <p className="pawn-result-item">
                    <strong>Applicable Interest Rate:</strong>{" "}
                    {interestRate?.toFixed(1)}%
                  </p>
                  <p className="pawn-result-item">
                    <strong>Estimated Interest:</strong>{" "}
                    ₱
                    {interestAmount.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                  {mode === "redeem" ? (
                    <p className="pawn-result-item">
                      <strong>Total to Redeem (Principal + Interest):</strong>{" "}
                      ₱
                      {totalPayable.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                  ) : (
                    <p className="pawn-result-item">
                      <strong>Estimated to Renew (Interest Only):</strong>{" "}
                      ₱
                      {interestAmount.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>

            <p className="pawn-calculator-disclaimer">
              *For sample estimation only. Actual rates, maturity, and grace periods vary per branch.
            </p>
          </div>
        </section>

        {/* SECTION 6: Terms & Conditions */}
        <section id="terms-and-conditions" className="pawn-section pawn-section-alt">
          <div className="pawn-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaShieldAlt className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="pawn-section-title">Terms &amp; Conditions (Key Points)</h2>
            </div>
            <p className="pawn-section-subtitle">
              Important information about your pawn transaction
            </p>
          </div>

          <div className="pawn-terms-grid">
            <div className="pawn-terms-card">
              <ul className="pawn-terms-list">
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>Charges &amp; Periods:</strong> Exact interest,
                    fees, and grace periods are printed on your pawn ticket.
                  </span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>Ticket is Your Contract:</strong> Keep it safe. It's required for renewals and redemption.
                  </span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>KYC / AMLA:</strong> Valid ID and documentation are required to comply with AMLA.
                  </span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>BSP-Regulated:</strong> We strictly follow Bangko Sentral ng Pilipinas regulations.
                  </span>
                </li>
              </ul>
            </div>

            <div className="pawn-terms-card">
              <ul className="pawn-terms-list">
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>Redemption &amp; Renewals:</strong> Only the pawner or an authorized representative may redeem.
                  </span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>Unredeemed Items:</strong> May be auctioned following BSP rules and notices.
                  </span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>Care &amp; Liability:</strong> Items are stored securely per industry standards.
                  </span>
                </li>
                <li>
                  <FaCheckCircle className="pawn-check-icon" />
                  <span>
                    <strong>Privacy:</strong> See our{" "}
                    <Link
                      to="/privacy-policy"
                      className="pawn-terms-link"
                    >
                      Privacy Policy
                    </Link>{" "}
                    for how your data is handled.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <div className="pawn-terms-notice">
            <FaExclamationTriangle className="pawn-warning-icon" />
            <p className="pawn-compliance-text">
              This summary is for convenience only. The{" "}
              <strong>pawn ticket</strong> and applicable laws prevail.
              For complete terms, visit{" "}
              <Link
                to="/terms"
                className="pawn-terms-link"
              >
                Terms &amp; Conditions
              </Link>.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="pawn-cta-banner">
          <h2 className="pawn-cta-title">
            Visit Us for a Free Appraisal
          </h2>
          <p className="pawn-cta-subtitle">
            Our appraisers will evaluate your jewelry and walk you through
            all charges and terms clearly.
          </p>
          <div className="pawn-cta-buttons">
            <Link
              to="/branches"
              className="pawn-cta-primary"
            >
              Find a Branch
            </Link>
            <Link
              to="/faqs"
              className="pawn-cta-secondary"
            >
              Read FAQs
            </Link>
          </div>
        </section>
      </main>

      {/* Global footer */}
      <Footer />
    </div>
  );
}

export default Pawning;
