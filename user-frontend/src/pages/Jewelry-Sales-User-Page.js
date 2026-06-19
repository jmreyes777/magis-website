// src/pages/Jewelry-Sales-User-Page.jsx
import React from "react";
import Seo from "../components/Seo";
import { Link } from "react-router-dom";
import Footer from "../components/Footer-User-Component";
import FacebookLatestVideo from "../components/FacebookLatestVideo";
import { FaGem, FaShieldAlt, FaCheckCircle, FaMapMarkedAlt, FaComments } from "react-icons/fa";
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

  const peso = (n) =>
    new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(Math.round(n || 0));

  const roundUpTo = (n, step) => Math.ceil((n || 0) / step) * step;
  const roundBase = (n) => {
    const whole = Math.ceil(n || 0);
    const rem = whole % 100;
    if (rem === 0 || rem === 50) return whole;
    if (rem < 50) return whole + (50 - rem);
    return whole + (100 - rem);
  };

  const opt1 = (p) => {
    const base = Math.round(p);
    const down = Math.round(base * 0.1);
    return {
      base,
      down,
      balance: base - down,
      months: "One-time payment within 2 weeks",
      label: "10% Down • 90% One-time",
    };
  };

  const opt2 = (p) => {
    const withFee = p * 1.04;
    const base = roundBase(withFee);
    const down = roundUpTo(base * 0.2, 50);
    const balance = base - down;
    let months = "Ask branch for terms";
    if (base >= 3000 && base <= 5000)
      months = "2 months to pay (80% Outstanding)";
    else if (base >= 5001) months = "3 months to pay (80% Outstanding)";
    return {
      base,
      withFee: Math.round(withFee),
      down,
      balance,
      months,
      label: "20% Down • +4% (rounded)",
    };
  };

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
        <div className="jewelry-calculator-result-card">
          <p className="jewelry-calculator-result-label">
            Selected
          </p>
          <p className="jewelry-calculator-result-title">{res.label}</p>
          {option === "opt2" ? (
            <>
              <p className="jewelry-calculator-result-item">
                Principal + 4%: <strong>{peso(res.withFee)}</strong>
              </p>
              <p className="jewelry-calculator-result-item">
                Rounded base: <strong>{peso(res.base)}</strong>
              </p>
              <p className="jewelry-calculator-result-item">
                20% Down (₱50-round): <strong>{peso(res.down)}</strong>
              </p>
            </>
          ) : (
            <>
              <p className="jewelry-calculator-result-item">
                Tag Price: <strong>{peso(res.base)}</strong>
              </p>
              <p className="jewelry-calculator-result-item">
                10% Down: <strong>{peso(res.down)}</strong>
              </p>
            </>
          )}
        </div>

        <div className="jewelry-calculator-result-card">
          <p className="jewelry-calculator-result-label">
            Outstanding
          </p>
          <p className="jewelry-calculator-result-item">
            Balance: <strong>{peso(res.balance)}</strong>
          </p>
          <p className="jewelry-calculator-result-item">{res.months}</p>
          <p className="jewelry-calculator-disclaimer">
            * Confirm final computation in-branch.
          </p>
        </div>
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

  const faqs = [
    {
      q: "What karat gold do you sell?",
      a: "Most pieces are 10K–18K. Ask our staff for the karat and weight marked on the tag.",
    },
    {
      q: "Are prices negotiable?",
      a: "Prices are transparent and already discounted. Promotions may apply — just ask our team.",
    },
    {
      q: "Do you offer repairs or cleaning?",
      a: "Basic cleaning or resizing may be available at select branches or partner shops.",
    },
    {
      q: "Can I return or exchange an item?",
      a: "For hygiene and valuation reasons, sales are final. Items are inspected before release.",
    },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-white text-gray-800">
      <Seo
        title="Jewelry Sales | Magis Gold & Gems"
        description="Fine gold jewelry at fair prices — rings, earrings, bracelets, chains, bangles, and pendants. Learn about layaway options and FAQs."
        path="/jewelry-sales"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Jewelry Sales", path: "/jewelry-sales" },
        ]}
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
                <p className="jewelry-accordion-text">{f.a}</p>
              </details>
            ))}
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
                <strong>Final Sale:</strong> Sales are final. Repairs/exchanges follow policy.
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
