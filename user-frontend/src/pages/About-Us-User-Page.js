// user-frontend/src/pages/About-Us-User-Page.js
// About Us — Vision & Mission. Same discreet private-wealth design language as
// Home/Pawn (flat navy/paper, gold hairlines) with minimal branded motion:
// hero entrance rises, IntersectionObserver scroll-reveals, and a line-drawn
// gold diamond ornament. Reveal classes are applied by JS ONLY when animation
// is viable (IO support + no reduced-motion + element below the fold), so the
// prerender snapshot and crawlers always see fully visible content.
import React from "react";
import { Link } from "react-router-dom";
import {
  FaBolt,
  FaShieldAlt,
  FaTags,
  FaHandHoldingHeart,
  FaBalanceScale,
  FaGraduationCap,
} from "react-icons/fa";
import Footer from "../components/Footer-User-Component";
import Seo, { SITE_ORIGIN, SITE_NAME } from "../components/Seo";
import useScrollReveal from "../hooks/useScrollReveal";
import "./About-Us-User-Page.css";

// ===========================================================================
// STRUCTURED DATA (module scope) — AboutPage referencing the homepage
// LocalBusiness node by @id (same pattern as the Service pages).
// ===========================================================================
const ANNIV_VIDEO_JSONLD = {
  "@type": "VideoObject",
  "@id": `${SITE_ORIGIN}/about-us#anniversary-video`,
  name: "Magis Pawnshop 30th Anniversary",
  description:
    "Thirty years of serving Filipino communities — a look back at Magis Gold & Gems Pawnshop & Jewelry since 1996.",
  thumbnailUrl: `${SITE_ORIGIN}/images/30th-anniversary-poster.jpg`,
  contentUrl: `${SITE_ORIGIN}/videos/30th-anniversary.mp4`,
  uploadDate: "2026-08-13",
  duration: "PT1M",
  inLanguage: "en-PH",
  publisher: { "@id": `${SITE_ORIGIN}/#business` },
};

const ABOUT_JSONLD = {
  "@type": "AboutPage",
  "@id": `${SITE_ORIGIN}/about-us#webpage`,
  url: `${SITE_ORIGIN}/about-us`,
  name: `About Us — Vision & Mission | ${SITE_NAME}`,
  description:
    "The vision and mission of Magis Gold & Gems Pawnshop & Jewelry: transparent, dignified pawning (sangla), certified subasta jewelry, and bills payment for Filipino communities since 1996.",
  about: { "@id": `${SITE_ORIGIN}/#business` },
  inLanguage: "en-PH",
};

// Mission pillars distilled from the mission statement (visible text below
// mirrors the full statement verbatim; these aid scanning/comprehension).
const PILLARS = [
  {
    Icon: FaBolt,
    title: "Fast & Transparent Services",
    text: "Gold pawning (sangla), certified subasta jewelry, and reliable bills payment — delivered quickly, with nothing hidden.",
  },
  {
    Icon: FaShieldAlt,
    title: "Absolute Security",
    text: "Strict, reliable transaction verification protocols protect every item and every peso entrusted to us.",
  },
  {
    Icon: FaTags,
    title: "Plain-Language Pricing",
    text: "Highly affordable cost structures explained in plain language — you always know exactly what you pay.",
  },
  {
    Icon: FaHandHoldingHeart,
    title: "Dignity & Community",
    text: "Consumer protection, dignity, and unwavering community support are our core philosophy, not a slogan.",
  },
  {
    Icon: FaBalanceScale,
    title: "The Appraisal Ritual",
    text: "Our transparent appraisal ritual and empathetic service are designed to alleviate financial anxiety.",
  },
  {
    Icon: FaGraduationCap,
    title: "Trust & Financial Literacy",
    text: "Respectful, non-judgmental financial partners in every neighborhood — turning assets into relief and long-term security.",
  },
];

function AboutUs() {
  // Shared scroll-reveal (src/hooks/useScrollReveal) with this page's local
  // hidden-state class — .about-reveal also drives the ornament line-draw
  // and the phrase stagger in About-Us-User-Page.css.
  const rootRef = useScrollReveal("about-reveal");

  return (
    <div className="about-page" ref={rootRef}>
      <Seo
        title={`About Us — Vision & Mission | ${SITE_NAME}`}
        description="Since 1996, Magis Gold & Gems has served Filipino communities with transparent gold pawning (sangla), certified subasta jewelry, and bills payment. Read our vision and mission."
        path="/about-us"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "About Us", path: "/about-us" },
        ]}
        jsonLd={[ABOUT_JSONLD, ANNIV_VIDEO_JSONLD]}
      />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <header className="about-hero">
        <div className="about-shell">
          <p className="about-eyebrow">About Magis Gold &amp; Gems</p>
          <h1 className="about-hero__title">
            A community financial anchor, <em>built on trust</em>.
          </h1>
          <p className="about-hero__sub">
            Since 1996, hardworking Filipino individuals and families have
            trusted Magis to turn their assets into immediate relief — with
            transparency, dignity, and empathy at every counter.
          </p>
          <div className="about-hero__stats" aria-label="Company at a glance">
            <div className="about-stat">
              <span className="about-stat__num">1996</span>
              <span className="about-stat__label">Established</span>
            </div>
            <div className="about-stat">
              <span className="about-stat__num">11</span>
              <span className="about-stat__label">Branches</span>
            </div>
            <div className="about-stat">
              <span className="about-stat__num">BSP</span>
              <span className="about-stat__label">Regulated</span>
            </div>
          </div>
        </div>
      </header>

      <main>
        {/* ── Vision ─────────────────────────────────────────────────────── */}
        <section className="about-section about-vision" aria-labelledby="about-vision-h" data-reveal>
          <div className="about-shell">
            <p className="about-eyebrow">Our Vision</p>
            <h2 id="about-vision-h" style={{ position: "absolute", left: "-9999px" }}>
              Vision
            </h2>
            <div className="about-vision__inner">
              <p className="about-vision__statement">
                <span className="about-vision__phrase" style={{ "--d": "0.1s" }}>
                  To be the premier <span className="about-gold">community financial anchor</span> in the Philippines,{" "}
                </span>
                <span className="about-vision__phrase" style={{ "--d": "0.45s" }}>
                  providing <span className="about-gold">transparent and dignified</span> liquidity solutions{" "}
                </span>
                <span className="about-vision__phrase" style={{ "--d": "0.8s" }}>
                  that empower individuals and protect their financial well-being.
                </span>
              </p>
              <svg
                className="about-vision__ornament"
                viewBox="0 0 132 132"
                role="presentation"
                aria-hidden="true"
                focusable="false"
              >
                {/* Line-drawn gem: outer diamond, table facet, girdle strokes */}
                <path d="M66 8 L124 66 L66 124 L8 66 Z" pathLength="1" />
                <path d="M66 34 L98 66 L66 98 L34 66 Z" pathLength="1" />
                <line x1="66" y1="8" x2="66" y2="34" pathLength="1" />
                <line x1="124" y1="66" x2="98" y2="66" pathLength="1" />
                <line x1="66" y1="124" x2="66" y2="98" pathLength="1" />
                <line x1="8" y1="66" x2="34" y2="66" pathLength="1" />
              </svg>
            </div>
          </div>
        </section>

        {/* ── Mission ────────────────────────────────────────────────────── */}
        <section className="about-section about-section--navy about-mission" aria-labelledby="about-mission-h" data-reveal>
          <div className="about-shell">
            <p className="about-eyebrow">Our Mission</p>
            <h2 id="about-mission-h" className="about-h2">
              Turning assets into relief — and relief into security.
            </h2>
            <p className="about-lead">
              Our mission is to serve hardworking Filipino individuals and
              families operating across local communities in the Philippines by
              providing <span className="about-gold">fast, transparent gold pawning</span>,{" "}
              <span className="about-gold">certified subasta jewelry</span>, and{" "}
              <span className="about-gold">reliable bills payment services</span>.
              Implementing strict, reliable transaction verification protocols
              to ensure absolute security, we aim to sustainably grow our Blue
              Gems and Magis group of companies while maintaining highly
              affordable, <span className="about-gold">plain-language cost structures</span>.
            </p>
            <p className="about-lead">
              We adhere strictly to our core philosophy of{" "}
              <span className="about-gold">consumer protection, dignity, and unwavering community support</span>.
              Our distinct competitive advantage lies in our{" "}
              <span className="about-gold">transparent appraisal ritual</span> and
              empathetic customer service, specifically designed to alleviate
              financial anxiety.
            </p>
            <p className="about-lead">
              We strive to be a{" "}
              <span className="about-gold">beacon of trust and financial literacy</span>{" "}
              in every neighborhood we serve, empowering our dedicated employees
              to act as respectful, non-judgmental financial partners who turn
              our clients&rsquo; assets into immediate relief and long-term
              security.
            </p>
          </div>
        </section>

        {/* ── Mission pillars ────────────────────────────────────────────── */}
        <section className="about-section" aria-labelledby="about-pillars-h">
          <div className="about-shell">
            <div data-reveal>
              <p className="about-eyebrow">What This Means Daily</p>
              <h2 id="about-pillars-h" className="about-h2">
                Six commitments behind every transaction
              </h2>
            </div>
            <div className="about-pillar-grid">
              {PILLARS.map(({ Icon, title, text }, i) => (
                <article
                  className="about-pillar"
                  key={title}
                  data-reveal
                  style={{ "--d": `${(i % 3) * 0.08}s` }}
                >
                  <span className="about-pillar__icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <h3 className="about-pillar__title">{title}</h3>
                  <p className="about-pillar__text">{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── 30th anniversary ──────────────────────────────────────── */}
        <section className="about-section about-anniv" aria-labelledby="about-anniv-h" data-reveal>
          <div className="about-shell">
            <div className="about-anniv__inner">
              <div className="about-anniv__copy">
                <p className="about-eyebrow">Celebrating 30 Years</p>
                <h2 id="about-anniv-h" className="about-h2">
                  Three decades of turning trust into relief
                </h2>
                <p className="about-anniv__text">
                  From a single counter in 1996 to <strong>11 branches</strong>{" "}
                  across Central Luzon and Quezon City — watch how three
                  decades of <strong>transparent appraisals</strong> and
                  neighborly service shaped the Magis of today.
                </p>
              </div>
              <div className="about-anniv__player">
                {/* preload=none: the ~20 MB reel downloads ONLY when the
                    visitor presses play — the page itself stays light. */}
                <video
                  controls
                  playsInline
                  preload="none"
                  poster="/images/30th-anniversary-poster.jpg"
                  aria-label="Magis Pawnshop 30th anniversary video"
                >
                  <source src="/videos/30th-anniversary.mp4" type="video/mp4" />
                  Your browser does not support the video tag.
                </video>
              </div>
            </div>
          </div>
        </section>

        {/* ── Closing ────────────────────────────────────────────────────── */}
        <section className="about-section about-section--navy about-closing" aria-label="Visit us" data-reveal>
          <div className="about-shell">
            <p className="about-closing__line">
              From your assets to <span className="about-gold">immediate relief</span> —
              and <span className="about-gold">long-term security</span>. That is the Magis promise.
            </p>
            <div className="about-cta-row">
              <Link to="/branches" className="about-cta">
                Find a Branch
              </Link>
              <Link to="/pawning" className="about-cta about-cta--ghost">
                How Pawning Works
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

export default AboutUs;
