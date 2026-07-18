// src/pages/Jewelry-Sales-User-Page.jsx
import React from "react";
import Seo from "../components/Seo";
import { Link } from "react-router-dom";
import Footer from "../components/Footer-User-Component";
import FacebookLatestVideo from "../components/FacebookLatestVideo";
import { FaGem, FaShieldAlt, FaCheckCircle, FaMapMarkedAlt, FaComments } from "react-icons/fa";
import { peso, opt1, opt2 } from "../utils/layawayMath";
import "./Jewelry-Sales-User-Page.css";

/* --------------------------------------------
   Safe image loader with fallback + fade-in
--------------------------------------------- */
const BASE = process.env.PUBLIC_URL || "";

function ImageWithFallback({ src, alt, className, ...rest }) {
  const [imgSrc, setImgSrc] = React.useState(src);
  const [hasTriedFallback, setHasTriedFallback] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    setImgSrc(src);
    setHasTriedFallback(false);
    setLoaded(false);
  }, [src]);

  const fallbackSrc = `${BASE}/images/placeholder.png`;
  const transparentPixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+v7c4sQAAAABJRU5ErkJggg==";

  // Serve a WebP variant (~95% smaller) to browsers that support it, derived
  // from the current .png source. Skipped once we've fallen back (placeholder /
  // data-URI have no .webp twin). The <img> stays the universal fallback, and
  // display:contents keeps the <img> in the parent layout as before.
  const webpSrc =
    !hasTriedFallback && /\.png$/i.test(imgSrc)
      ? imgSrc.replace(/\.png$/i, ".webp")
      : null;

  return (
    <picture style={{ display: "contents" }}>
      {webpSrc && <source srcSet={webpSrc} type="image/webp" />}
      <img
        src={imgSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (!hasTriedFallback) {
            setHasTriedFallback(true);
            setImgSrc(fallbackSrc);
          } else {
            setImgSrc(transparentPixel);
          }
        }}
        className={`${className || ""} transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        {...rest}
      />
    </picture>
  );
}

/* --------------------------------------------
   Layaway Calculator — Mobile-friendly design
--------------------------------------------- */
function LayawayCalculator() {
  const [price, setPrice] = React.useState(5000);
  const [option, setOption] = React.useState("opt2");

  const res = option === "opt1" ? opt1(price) : opt2(price);

  return (
    <div className="jewelry-calculator">
      <div className="jewelry-calculator-header">
        <div className="jewelry-calculator-input-group">
          <label className="jewelry-calculator-label">
            Tag Price (₱)
          </label>
          <input
            type="number"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="jewelry-calculator-input"
          />
        </div>

        <div className="jewelry-calculator-options">
          {["opt1", "opt2"].map((k) => (
            <button
              key={k}
              onClick={() => setOption(k)}
              className={`jewelry-calculator-btn ${option === k ? "active" : "inactive"}`}
            >
              {k === "opt1" ? "Option 1" : "Option 2"}
            </button>
          ))}
        </div>
      </div>

      <div className="jewelry-calculator-results">
        <div className="jewelry-calc-hero">
          <span className="jewelry-calc-hero-label">Pay today (down)</span>
          <span className="jewelry-calc-hero-amount">{peso(res.down)}</span>
          <span className="jewelry-calc-hero-plan">{res.label}</span>
        </div>

        <div className="jewelry-calc-chips">
          {option === "opt2" ? (
            <>
              <div className="jewelry-calc-chip">
                <span className="jewelry-calc-chip-label">Principal + 4%</span>
                <span className="jewelry-calc-chip-value">{peso(res.withFee)}</span>
              </div>
              <div className="jewelry-calc-chip">
                <span className="jewelry-calc-chip-label">Rounded base</span>
                <span className="jewelry-calc-chip-value">{peso(res.base)}</span>
              </div>
            </>
          ) : (
            <div className="jewelry-calc-chip">
              <span className="jewelry-calc-chip-label">Tag price</span>
              <span className="jewelry-calc-chip-value">{peso(res.base)}</span>
            </div>
          )}

          <div className="jewelry-calc-chip">
            <span className="jewelry-calc-chip-label">Balance</span>
            <span className="jewelry-calc-chip-value">{peso(res.balance)}</span>
          </div>

          <div className="jewelry-calc-chip jewelry-calc-chip-wide">
            <span className="jewelry-calc-chip-label">Terms</span>
            <span className="jewelry-calc-chip-value">{res.months}</span>
          </div>
        </div>

        <p className="jewelry-calculator-disclaimer">
          * Confirm final computation in-branch.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------
   Jewelry Sales Page
--------------------------------------------- */
export default function JewelrySales() {
  // Images live under public/images/, e.g. `${BASE}/images/pendant.png`
  const types = [
    { key: "rings",     label: "Ring",     src: `${BASE}/images/ring.png`,      alt: "Gold rings" },
    { key: "earrings",  label: "Earring",  src: `${BASE}/images/earring.png`,   alt: "Gold earrings" },
    { key: "bracelets", label: "Bracelet", src: `${BASE}/images/bracelet.png`,  alt: "Gold bracelets" },
    { key: "chains",    label: "Chain",    src: `${BASE}/images/chain.png`,     alt: "Gold chains" },
    { key: "necklace",  label: "Necklace", src: `${BASE}/images/necklace.png`,  alt: "Gold necklaces" },
    { key: "bangles",   label: "Bangle",   src: `${BASE}/images/bangle.png`,    alt: "Gold bangles" },
    { key: "pendants",  label: "Pendant",  src: `${BASE}/images/pendant.png`,   alt: "Gold pendants" },
  ];

  // Answers may be a string or an array of paragraphs (rendered as separate
  // <p>s; joined for the FAQPage JSON-LD text).
  const faqs = [
    {
      q: "What is Subasta?",
      a: [
        "Subasta jewelry refers to pre-owned pieces that have been acquired through pawnshop auction or unclaimed collateral. These items are carefully selected for resale based on their condition, design, and overall value.",
        "At Magi’s, Subasta pieces are offered as a practical way to buy real gold jewelry at more accessible price points. As with any pre-owned jewelry, minor signs of previous use may be present unless otherwise stated.",
      ],
    },
    {
      q: "Is your jewelry authentic gold?",
      a: [
        "Yes, we sell real gold jewelry. Our pieces are checked and classified according to their gold purity before being offered for sale.",
        "If you have questions about a specific item’s karat, weight, or condition, our team will be happy to explain the details before you purchase.",
      ],
    },
    {
      q: "What gold karats do you sell?",
      a: [
        "We usually carry 14K, 18K, and 21K gold jewelry, and other karats depending on current availability.",
        "Stock may vary by branch or release, so if you are looking for a specific karat, it is best to ask our staff directly.",
      ],
    },
    {
      q: "What is value-tier gold?",
      a: [
        "Value-tier gold refers to genuine gold jewelry selected for buyers who want lower entry price points while still purchasing real gold.",
        "These pieces may be lighter in weight, simpler in design, or priced more accessibly than premium selections. They are a good option for everyday wear, gifting, or budget-conscious buying.",
      ],
    },
    {
      q: "Are your prices negotiable?",
      a: [
        "Some items may have a little room for adjustment, while others are already priced at their best available rate.",
        "If you are interested in a piece, feel free to ask politely. Our team can let you know if there is any flexibility based on the item, payment arrangement, and current pricing.",
      ],
    },
    {
      q: "Do you offer cleaning or repairs?",
      a: [
        "Our standard Subasta items are cleaned and polished in-house on a monthly basis and displayed in their best available condition.",
        "We do not offer in-house repair services. Value-Tier items are sold as-is. If you need alteration, repair, or customization after purchase, we can recommend trusted goldsmith partners.",
      ],
    },
    {
      q: "Do you accept returns or exchanges?",
      a: [
        "Because jewelry is a personal and high-value item, returns and exchanges are handled with care and subject to store policy.",
        "If there is an issue with your purchase, please contact us as soon as possible. We will review the concern based on the item’s condition, the time since purchase, and the nature of the issue. Approval is not automatic, but we aim to handle concerns fairly and clearly.",
      ],
    },
    {
      q: "Can I reserve an item or place it on layaway?",
      a: [
        "Yes. Selected items may be placed on reservation or layaway, subject to approval and payment terms.",
        "Reservation and layaway help secure a piece while you complete payment within the agreed period. Availability, down payment amount, and schedule may vary depending on the item.",
      ],
    },
    {
      q: "How does the 2-week reservation plan work?",
      a: [
        "Our 2-week reservation plan is for customers who want to secure an item and complete payment within a short period.",
        "In this case:",
        "• A down payment is required to reserve the item",
        "• The balance must be paid within 14 days",
        "• The item remains on hold while payments are updated under the agreed terms",
        "If payment is not completed on time, the reservation may be released according to store policy. Please confirm the exact terms with our team before making a down payment.",
      ],
    },
    {
      q: "Do you offer an extended layaway plan?",
      a: [
        "Yes, we offer extended layaway for selected items, depending on the value of the jewelry and the payment arrangement approved.",
        "Extended layaway allows a longer payment period than the standard 2-week option. Terms such as down payment, installment schedule, and holding period will be explained before confirmation so expectations are clear on both sides.",
      ],
    },
    {
      q: "Can I take the jewelry home after making a downpayment?",
      a: [
        "In this case, no. Jewelry under reservation or layaway remains with Magi’s until the full payment has been completed.",
        "This helps protect both the customer and the store by making sure the item is properly secured until the sale is fully settled.",
      ],
    },
  ];

  // FAQPage schema built from the same `faqs` array that renders below, so the
  // structured data always matches the visible accordion (Wave 2 — SEO plan).
  const faqSchema = {
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: Array.isArray(f.a) ? f.a.join("\n\n") : f.a },
    })),
  };

  return (
    <div className="flex flex-col min-h-screen bg-white text-gray-800">
      <Seo
        title="Gold Jewelry for Sale (Alahas) | Magis Gold & Gems"
        description="Buy fine gold jewelry (alahas) in the Philippines — rings, necklaces, earrings and bracelets at fair, transparent prices, with layaway (hulugan) options."
        path="/jewelry-sales"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Jewelry Sales", path: "/jewelry-sales" },
        ]}
        jsonLd={faqSchema}
      />

      <main className="flex-1">
        {/* HERO */}
        <section
          id="hero"
          className="jewelry-hero"
        >
          <div className="jewelry-hero-content">
            <h1 className="jewelry-hero-title">
              Quality Gold Jewelry, Fair and Affordable
            </h1>
            <p className="jewelry-hero-subtitle">
              Discover fine gold pieces for everyday wear and special moments —
              available at our branches. Visit us to view actual items and pricing.
            </p>
            <div className="jewelry-hero-cta-container">
              <Link
                to={{ pathname: "/branches", search: "?filter=jewelry" }}
                className="btn-primary-cta"
              >
                Find a Jewelry Branch <FaMapMarkedAlt className="ml-2" />
              </Link>
              <button
                onClick={() => window.location.href = '/branches'}
                className="btn-secondary-cta"
              >
                Chat With Our Team <FaComments className="ml-2" />
              </button>
            </div>
            <div className="jewelry-hero-trust">
              <span className="jewelry-hero-trust-item"><FaGem /> 10K–24K gold</span>
              <span className="jewelry-hero-trust-item"><FaShieldAlt /> Actual pricing</span>
              <span className="jewelry-hero-trust-item"><FaCheckCircle /> Layaway (hulugan) available</span>
            </div>
          </div>
        </section>

        {/* ITEM TYPES */}
        <section id="types" className="jewelry-section">
          <div className="jewelry-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaGem className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="jewelry-section-title">Gold Jewelry Types</h2>
            </div>
            <p className="jewelry-section-subtitle">
              Styles and availability vary per branch. Visit us to view actual items and pricing.
            </p>
          </div>

          <div className="jewelry-types-grid">
            {types.map((t) => (
              <div
                key={t.key}
                className="jewelry-type-card"
              >
                <ImageWithFallback
                  src={t.src}
                  alt={t.alt}
                  className="jewelry-type-image"
                />
                <h3 className="jewelry-type-title">{t.label}</h3>
              </div>
            ))}
          </div>
        </section>

        {/* LAYAWAY */}
        <section id="layaway" className="jewelry-section jewelry-section-alt">
          <div className="jewelry-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaShieldAlt className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="jewelry-section-title">Layaway Options</h2>
            </div>
            <p className="jewelry-section-subtitle">
              Flexible payment plans to help you own your dream jewelry
            </p>
          </div>

          <div className="jewelry-layaway-grid">
            <div className="jewelry-layaway-card">
              <h4 className="jewelry-layaway-title">
                Payment Option 1
              </h4>
              <ul className="jewelry-layaway-list">
                <li>10% Down Payment</li>
                <li>Maximum 2 weeks to complete full payment</li>
                <li>90% One-time payment of outstanding balance</li>
              </ul>
              <p className="jewelry-layaway-example">
                <strong>Example:</strong> ₱5,000 × 10% = ₱500 down → ₱4,500 remaining.
              </p>
            </div>

            <div className="jewelry-layaway-card">
              <h4 className="jewelry-layaway-title">
                Payment Option 2
              </h4>
              <ul className="jewelry-layaway-list">
                <li>20% Down on (Principal + 4%)</li>
                <li>Plan 1: ₱3,000–₱5,000 → 2 months</li>
                <li>Plan 2: ₱5,001+ → 3 months</li>
                <li>Round base to nearest 50 or 100</li>
                <li>Down rounded up to nearest ₱50</li>
              </ul>
              <p className="jewelry-layaway-example">
                <strong>Example:</strong> ₱4,000 + 4% = ₱4,160 → Rounded ₱4,200 → 20% = ₱832 → ₱850 down → ₱3,350 balance.
              </p>
            </div>
          </div>

          <div className="jewelry-calculator-container">
            <LayawayCalculator />
          </div>
        </section>

        {/* FAQS */}
        <section id="faqs" className="jewelry-section">
          <div className="jewelry-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaCheckCircle className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="jewelry-section-title">Frequently Asked Questions</h2>
            </div>
            <p className="jewelry-section-subtitle">
              Common questions about our jewelry sales
            </p>
          </div>

          <div className="jewelry-faq-container">
            {faqs.map((f, i) => (
              <details
                key={i}
                className="jewelry-accordion"
              >
                <summary>{f.q}</summary>
                {(Array.isArray(f.a) ? f.a : [f.a]).map((para, j) => (
                  <p key={j} className="jewelry-accordion-text">{para}</p>
                ))}
              </details>
            ))}
            <p className="jewelry-section-subtitle" style={{ marginTop: "1.5rem" }}>
              If you have questions about a specific piece, payment option, or returns
              request, message Magi’s directly so we can guide you based on current
              availability and branch policy.
            </p>
          </div>
        </section>

        {/* TERMS */}
        <section id="terms" className="jewelry-section">
          <div className="jewelry-section-header">
            <div className="flex flex-col md:flex-row items-center justify-center md:justify-start gap-3 mb-2">
              <FaCheckCircle className="text-3xl" style={{ color: '#d4a853' }} />
              <h2 className="jewelry-section-title">
                Terms &amp; Conditions (Sales)
              </h2>
            </div>
            <p className="jewelry-section-subtitle">
              Important information about jewelry purchases
            </p>
          </div>

          <div className="jewelry-terms-grid">
            <div className="jewelry-terms-card">
              <p className="jewelry-terms-item">
                <strong>Karat &amp; Weight:</strong> Tags show karat, weight, and price. Verify before purchase.
              </p>
              <p className="jewelry-terms-item">
                <strong>Pricing:</strong> Prices vary per branch and may change without prior notice.
              </p>
              <p className="jewelry-terms-item">
                <strong>Condition:</strong> Items are inspected before release; slight variations may occur.
              </p>
              <p className="jewelry-terms-item">
                <strong>Receipts:</strong> Official receipts reflect item details and payment amount.
              </p>
            </div>

            <div className="jewelry-terms-card">
              <p className="jewelry-terms-item">
                <strong>Returns &amp; Exchanges:</strong> Handled with care and subject to store policy — contact us promptly about any concern.
              </p>
              <p className="jewelry-terms-item">
                <strong>Availability:</strong> Stocks differ per branch; some items may sell quickly.
              </p>
              <p className="jewelry-terms-item">
                <strong>Compliance:</strong> All transactions follow BSP and consumer regulations.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="jewelry-cta-banner">
            <h2 className="jewelry-cta-title">
              Ready to Inquire About Available Jewelry?
            </h2>
            <p className="mb-6 text-sm md:text-base max-w-2xl mx-auto">
              Our staff can help with sizing, pricing, and availability. We’re happy to assist!
            </p>
            <div className="jewelry-cta-buttons">
              <Link
                to={{ pathname: "/branches", search: "?filter=jewelry" }}
                className="jewelry-cta-primary"
              >
                Find a Jewelry Branch <FaMapMarkedAlt className="ml-2" />
              </Link>
              <button
                onClick={() => window.location.href = '/branches'}
                className="jewelry-cta-secondary"
              >
                Chat With Our Team <FaComments className="ml-2" />
              </button>
            </div>
        </section>

        <section id="live-video" className="jewelry-live-section">
          <div className="jewelry-live-header">
            <h2 className="jewelry-live-title">Live Selling Sessions</h2>
            <p className="jewelry-live-subtitle">
              Watch our live selling sessions to see featured jewelry designs. For current availability, message us or visit your nearest branch.
            </p>
          </div>
          <div className="jewelry-live-container">
            <FacebookLatestVideo />
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
