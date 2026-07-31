// src/pages/NotFound-User-Page.js
// Real 404 page (Wave 3 — SEO-6). Replaces the old soft-404 redirect to "/".
// Emits <Seo noindex> so crawlers drop the bad URL instead of indexing a
// duplicate of the homepage, and offers helpful links back into the site.
import React from "react";
import { Link } from "react-router-dom";
import Footer from "../components/Footer-User-Component";
import Seo from "../components/Seo";

const HELPFUL_LINKS = [
  { to: "/", label: "Home" },
  { to: "/pawning", label: "Sangla" },
  { to: "/jewelry-sales", label: "Jewelry Sales" },
  { to: "/branches", label: "Hanapin ang Branch" },
  { to: "/faqs", label: "FAQs" },
  { to: "/contact-us", label: "Contact Us" },
];

const NotFound = () => {
  return (
    <div className="flex flex-col min-h-screen">
      <Seo
        title="Page Not Found | Magis Gold & Gems Pawnshop"
        description="Sorry, the page you’re looking for doesn’t exist or has moved. Explore pawning, jewelry sales, branches, and FAQs at Magis Gold & Gems."
        path="/404"
        noindex
      />

      {/* Hero */}
      <section
        className="relative h-72 md:h-80 bg-cover bg-center"
        style={{ backgroundImage: "url('/images/hero.jpg')" }}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e]/90 via-[#1a1a2e]/80 to-[#2d2d42]/85" />
        <div className="relative z-10 flex h-full flex-col items-center justify-center px-4 text-center text-white">
          <h1 className="mb-3 text-6xl md:text-7xl font-extrabold tracking-tight text-[#d4a853]">404</h1>
          <p className="text-base text-gray-200 md:text-lg">
            Pasensya na — hindi namin mahanap ang page na ’yan.
          </p>
        </div>
      </section>

      {/* Helpful links */}
      <main className="flex-grow">
        <section className="py-12 bg-white">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <p className="text-gray-700 mb-8">
              Baka lumipat na o wala na ang page. Subukan ang isa sa mga ito:
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {HELPFUL_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="rounded-full border border-[#d4a853]/50 bg-white px-6 py-3 font-semibold text-[#1a1a2e] transition hover:border-[#d4a853] hover:bg-[#d4a853]/10"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default NotFound;
