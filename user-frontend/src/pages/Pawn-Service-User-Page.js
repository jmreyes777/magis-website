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
import { getRateFromDays, daysBetween, computeInterest } from "../utils/pawnMath";
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
      setCalcError("Hindi pwedeng mas maaga ang petsa ng bayad kaysa sa petsa ng sangla.");
      return;
    }

    // compute whole days (round up to next full day)
    const d = daysBetween(start, end);
    setDaysElapsed(d);

    const rate = getRateFromDays(d);
    setInterestRate(rate);
    setInterestAmount(computeInterest(p, rate));
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
          <h1 className="pawn-hero__title">I-pawn ang ginto mo — ligtas at walang kaba.</h1>
          <p className="pawn-hero__sub">
            Mabilis at patas na cash para sa gold jewelry mo — kadalasan minuto
            lang, malinaw ang usapan, at pribado ang transaksyon.
          </p>
          <div className="pawn-cta-row">
            <Link to="/branches" className="pawn-cta">
              <FaComments aria-hidden="true" /> Mag-chat sa Branch{" "}
              <FaArrowRight aria-hidden="true" />
            </Link>
            <Link to="/faqs" className="pawn-cta pawn-cta--ghost">
              Basahin ang FAQs <FaArrowRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <main className="flex-1">
        {/* SECTION 1: How to Pawn */}
        <section id="how-to-pawn" className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Paano mag-sangla</p>
              <h2 className="pawn-h2">Simple at malinaw na proseso.</h2>
              <p className="pawn-lead">
                Ligtas at diretso — makukuha mo ang patas na halaga para sa ginto mo sa ilang hakbang lang.
              </p>
            </div>

            <div className="pawn-cell-grid">
              {[
                {
                  icon: <FaRegIdCard aria-hidden="true" />,
                  num: "STEP 1",
                  title: "Dalhin ang alahas",
                  text: "Pumunta sa kahit anong branch dala ang gold jewelry mo at isang valid government ID.",
                },
                {
                  icon: <FaBalanceScale aria-hidden="true" />,
                  num: "STEP 2",
                  title: "Appraisal",
                  text: "Susuriin namin ang karat, timbang, at kondisyon para malaman ang patas na halaga ng loan.",
                },
                {
                  icon: <FaClipboardCheck aria-hidden="true" />,
                  num: "STEP 3",
                  title: "Alok at ticket",
                  text: "Silipin ang charges at terms. Kapag sang-ayon ka, pirmahan ang ticket at kunin ang cash.",
                },
                {
                  icon: <FaMoneyBillAlt aria-hidden="true" />,
                  num: "STEP 4",
                  title: "Ligtas na tago",
                  text: "Itatago namin nang ligtas ang alahas mo hanggang sa pagtubos o pag-renew, ayon sa pamantayan ng BSP.",
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
                <strong>Para panatag ka:</strong> Bawat alahas ay ina-appraise ng sanay na staff,
                nakatala sa opisyal na pawn ticket, at nakatago nang ligtas hanggang sa tubusin mo.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 2: Accepted Items */}
        <section id="accepted-items" className="pawn-section pawn-section--navy">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Mga tinatanggap</p>
              <h2 className="pawn-h2">Anong alahas ang tinatanggap namin.</h2>
              <p className="pawn-lead">
                Malawak ang tinatanggap naming gold jewelry para sa appraisal at sangla.
              </p>
            </div>

            <div className="pawn-cell-grid">
              <div className="pawn-cell">
                <span className="pawn-cell__icon"><FaMoneyBillAlt aria-hidden="true" /></span>
                <h3 className="pawn-cell__title">Gold jewelry</h3>
                <p className="pawn-cell__text">
                  Singsing, kwintas, pulseras, hikaw, palawit — lahat ng karat mula 10K hanggang 24K, susuriin ayon sa karat at timbang.
                </p>
              </div>
              <div className="pawn-cell">
                <span className="pawn-cell__icon"><FaBalanceScale aria-hidden="true" /></span>
                <h3 className="pawn-cell__title">May bato</h3>
                <p className="pawn-cell__text">
                  Maingat naming susuriin ang gold jewelry na may bato (hal. diamante).
                </p>
              </div>
              <div className="pawn-cell">
                <span className="pawn-cell__icon"><FaInfoCircle aria-hidden="true" /></span>
                <h3 className="pawn-cell__title">Itanong sa amin</h3>
                <p className="pawn-cell__text">
                  May iba ka pang alahas? Depende sa evaluation ng appraiser sa branch kung matatanggap.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 3: How to Renew */}
        <section id="how-to-renew" className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Paano mag-renew</p>
              <h2 className="pawn-h2">Palawigin ang term — bayaran lang ang interest.</h2>
              <p className="pawn-lead">
                Hindi mawawala ang alahas mo — iusog ang maturity date sa tatlong mabilis na hakbang.
              </p>
            </div>

            <div className="pawn-feature pawn-feature--solo">
              <h3 className="pawn-feature__title">Sundan lang ang tatlong hakbang</h3>
              <ul className="pawn-checklist">
                <li>Pumunta sa kahit anong Magis branch bago o sakto sa maturity date.</li>
                <li>Ipakita ang original na pawn ticket at valid ID.</li>
                <li>Bayaran ang charges na nakasulat sa ticket para ma-renew ang term.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* SECTION 4: How to Redeem */}
        <section id="how-to-redeem" className="pawn-section pawn-section--navy">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Paano tumubos</p>
              <h2 className="pawn-h2">Tubusin ang alahas mo.</h2>
              <p className="pawn-lead">
                Bayaran ang principal at mga charges, tapos iuwi na ang alahas mo.
              </p>
            </div>

            <div className="pawn-feature-grid">
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Mga kailangan</h3>
                <ul className="pawn-checklist">
                  <li>Original na pawn ticket.</li>
                  <li>Valid ID ng nagsangla o ng kinatawan.</li>
                  <li>Bayad sa principal at mga charges.</li>
                </ul>
              </div>
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Mga paalala</h3>
                <ul className="pawn-checklist">
                  <li className="is-warn">
                    Kailangan ng kinatawan ang authorization letter, valid ID, at ang original na pawn ticket.
                  </li>
                  <li className="is-warn">
                    Pagkatapos ng verification, ibibigay ang alahas kasama ang natubos na ticket.
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
              <h2 className="pawn-h2">I-estimate ang babayaran mo.</h2>
              <p className="pawn-lead">
                Pang-plano lang ito — iba-iba ang aktwal na rate kada branch at nakasulat ito sa pawn ticket mo.
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
                  <label htmlFor="principal">Halaga ng principal (₱)</label>
                  <input
                    type="number"
                    id="principal"
                    min="0"
                    placeholder="Ilagay ang halaga"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                  />
                </div>
                <div className="pawn-field">
                  <label htmlFor="pawnDate">Petsa ng sangla</label>
                  <input
                    type="date"
                    id="pawnDate"
                    value={pawnDate}
                    onChange={(e) => setPawnDate(e.target.value)}
                  />
                </div>
                <div className="pawn-field">
                  <label htmlFor="paymentDate">Planong petsa ng bayad</label>
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
                    <p>Punan ang tatlong field sa taas — lalabas agad dito ang estimate mo.</p>
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
                        ? "Principal + interest — bayaran nang buo para maiuwi ang alahas mo."
                        : "Interest lang — ito ang bayaran para umusog ang term mo."}
                    </p>

                    <div className="pawn-stats">
                      <div className="pawn-stat">
                        <span className="pawn-stat__label">Araw na lumipas</span>
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
                *Sample estimate lang ito. Iba-iba ang aktwal na rates, maturity, at grace period kada branch.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 6: Terms & Conditions */}
        <section id="terms-and-conditions" className="pawn-section pawn-section--navy">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Terms &amp; conditions</p>
              <h2 className="pawn-h2">Patas na terms, malinaw na paliwanag.</h2>
              <p className="pawn-lead">Simpleng buod kung paano gumagana ang sangla mo — mula ticket hanggang araw ng pagtubos.</p>
            </div>

            <div className="pawn-feature-grid">
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Ang transaksyon mo</h3>
                <ul className="pawn-checklist">
                  <li>
                    <strong>Charges at panahon:</strong> Nakasulat sa pawn ticket mo ang eksaktong
                    interest, charges, at grace period.
                  </li>
                  <li>
                    <strong>Ticket = kontrata mo:</strong> Ingatan ito — kailangan ito sa
                    pag-renew at pagtubos.
                  </li>
                  <li>
                    <strong>KYC / AMLA:</strong> Kailangan ang valid ID at dokumento bilang pagsunod sa AMLA.
                  </li>
                  <li>
                    <strong>BSP-regulated:</strong> Mahigpit kaming sumusunod sa regulasyon ng Bangko Sentral ng Pilipinas.
                  </li>
                </ul>
              </div>
              <div className="pawn-feature">
                <h3 className="pawn-feature__title">Pagtubos at pag-iingat</h3>
                <ul className="pawn-checklist">
                  <li>
                    <strong>Pagtubos at pag-renew:</strong> Tanging ang nagsangla o awtorisadong
                    kinatawan lang ang pwedeng tumubos.
                  </li>
                  <li>
                    <strong>Hindi natubos:</strong> Maaaring maisubasta ayon sa mga patakaran at abiso ng BSP.
                  </li>
                  <li>
                    <strong>Pag-iingat:</strong> Nakatago nang ligtas ang mga alahas ayon sa pamantayan ng industriya.
                  </li>
                  <li>
                    <strong>Privacy:</strong> Basahin ang{" "}
                    <Link to="/privacy-policy" className="pawn-link">Privacy Policy</Link>{" "}
                    namin kung paano iniingatan ang data mo.
                  </li>
                </ul>
              </div>
            </div>

            <div className="pawn-note">
              <FaExclamationTriangle aria-hidden="true" />
              <p>
                Pinadaling buod lang ito. Ang <strong>pawn ticket</strong> at umiiral na batas
                pa rin ang masusunod. Para sa kumpletong terms, puntahan ang{" "}
                <Link to="/terms" className="pawn-link">Terms &amp; Conditions</Link>.
              </p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Simulan na</p>
              <h2 className="pawn-h2">Dumaan ka — libre ang appraisal.</h2>
              <p className="pawn-lead">
                Susuriin ng appraiser namin ang alahas mo at ipapaliwanag nang malinaw ang lahat
                ng charges at terms — walang pressure, walang obligasyon.
              </p>
            </div>
            <div className="pawn-cta-row">
              <Link to="/branches" className="pawn-cta">
                <FaComments aria-hidden="true" /> Mag-chat sa Branch{" "}
                <FaArrowRight aria-hidden="true" />
              </Link>
              <Link to="/faqs" className="pawn-cta pawn-cta--ghost">
                Basahin ang FAQs <FaArrowRight aria-hidden="true" />
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
