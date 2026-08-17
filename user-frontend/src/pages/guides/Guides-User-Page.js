// src/pages/guides/Guides-User-Page.js
// SEO megaplan Wave 2 — guide hub pages. One shared template renders each
// guide from guide-content.js; all four routes ship in this single lazy chunk
// (they share the template + the pawn page's CSS, so separate chunks would
// just duplicate bytes). Fully static output — no fetches, no timers — which
// makes these pages prerender- and hydration-safe by construction.
import React from "react";
import { Link } from "react-router-dom";
import { FaArrowRight, FaComments, FaQuestionCircle } from "react-icons/fa";
import Footer from "../../components/Footer-User-Component";
import Seo from "../../components/Seo";
// Reuse the pawn page's design system (shell/section/cell/checklist/cta
// classes) so guides match the site look with zero new CSS to maintain.
import "../Pawn-Service-User-Page.css";
import { GUIDES, GUIDE_LINKS, GUIDES_PUBLISHED } from "./guide-content";

const publishedDisplay = new Date(`${GUIDES_PUBLISHED}T00:00:00`).toLocaleDateString(
  "en-PH",
  { year: "numeric", month: "long", day: "numeric" }
);

function GuideSection({ section, index }) {
  return (
    <section className={`pawn-section${index % 2 === 1 ? " pawn-section--navy" : ""}`}>
      <div className="pawn-shell">
        <div className="pawn-section-head">
          <h2 className="pawn-h2">{section.heading}</h2>
        </div>

        {Array.isArray(section.body) &&
          section.body.map((paragraph, i) => (
            <p className="pawn-lead guide-paragraph" key={i}>
              {paragraph}
            </p>
          ))}

        {Array.isArray(section.steps) && (
          <div className="pawn-cell-grid">
            {section.steps.map((step, i) => (
              <div key={i} className="pawn-cell">
                <span className="pawn-cell__num">{`STEP ${i + 1}`}</span>
                <h3 className="pawn-cell__title">{step.name}</h3>
                <p className="pawn-cell__text">{step.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function GuidePage({ guide }) {
  return (
    <div className="pawn-page flex flex-col min-h-screen">
      <Seo
        title={guide.title}
        description={guide.description}
        path={guide.path}
        type="article"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: guide.eyebrow, path: guide.path },
        ]}
        jsonLd={guide.jsonLd(guide)}
      />

      <main className="flex-1">
        {/* Hero INSIDE <main>: content outside landmarks fails axe's region
            rule (landmark navigation would skip it). */}
        <section className="pawn-hero">
          <div className="pawn-shell pawn-hero__inner">
            <p className="pawn-eyebrow">{guide.eyebrow}</p>
            <h1 className="pawn-hero__title">{guide.h1}</h1>
            <p className="pawn-hero__sub">{guide.lead}</p>
            <div className="pawn-cta-row">
              <Link to="/branches" className="pawn-cta">
                <FaComments aria-hidden="true" /> Free Appraisal at a Branch{" "}
                <FaArrowRight aria-hidden="true" />
              </Link>
              <Link to="/faqs" className="pawn-cta pawn-cta--ghost">
                View FAQs <FaArrowRight aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>

        {guide.sections.map((section, i) => (
          <GuideSection key={i} section={section} index={i} />
        ))}

        {/* On-page FAQ — visible text mirrors the FAQPage JSON-LD exactly */}
        <section className={`pawn-section${guide.sections.length % 2 === 1 ? " pawn-section--navy" : ""}`}>
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Common questions</p>
              <h2 className="pawn-h2">Quick answers.</h2>
            </div>
            <div className="pawn-feature-grid">
              {guide.faqs.map((faq, i) => (
                <div key={i} className="pawn-feature">
                  <h3 className="pawn-feature__title">
                    <FaQuestionCircle aria-hidden="true" /> {faq.q}
                  </h3>
                  <p className="pawn-cell__text">{faq.a}</p>
                </div>
              ))}
            </div>
            <p className="pawn-calc__note">Guide last reviewed {publishedDisplay}.</p>
          </div>
        </section>

        {/* Related guides + service links */}
        <section className="pawn-section">
          <div className="pawn-shell">
            <div className="pawn-section-head">
              <p className="pawn-eyebrow">Keep reading</p>
              <h2 className="pawn-h2">Related guides &amp; services.</h2>
            </div>
            <div className="pawn-feature pawn-feature--solo">
              <ul className="pawn-checklist">
                {guide.related.map((r, i) => (
                  <li key={i}>
                    <Link to={r.to} className="pawn-link">
                      {r.label}
                    </Link>
                  </li>
                ))}
                {GUIDE_LINKS.filter((g) => g.to !== guide.path)
                  .filter((g) => !guide.related.some((r) => r.to === g.to))
                  .map((g) => (
                    <li key={g.to}>
                      <Link to={g.to} className="pawn-link">
                        {g.label}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

export function GoldPricesGuide() {
  return <GuidePage guide={GUIDES.goldPrices} />;
}
export function HowToPawnGuide() {
  return <GuidePage guide={GUIDES.howToPawn} />;
}
export function KaratGuide() {
  return <GuidePage guide={GUIDES.karatGuide} />;
}
export function InterestRatesGuide() {
  return <GuidePage guide={GUIDES.interestRates} />;
}
