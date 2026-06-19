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
  { to: "/pawning", label: "Pawning" },
  { to: "/jewelry-sales", label: "Jewelry Sales" },
  { to: "/branches", label: "Find a Branch" },
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
        className="relative h-64 bg-cover bg-center"
        style={{ backgroundImage: "url('/images/hero.jpg')" }}
      >
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative z-10 flex flex-col items-center justify-center h-full text-center px-4 text-white">
          <h1 className="text-4xl md:text-5xl font-bold mb-2">404</h1>
          <p className="text-base md:text-lg opacity-90">
            Sorry, we couldn’t find that page.
          </p>
        </div>
      </section>

      {/* Helpful links */}
      <main className="flex-grow">
        <section className="py-12 bg-white">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <p className="text-gray-700 mb-8">
              The page may have moved or no longer exists. Try one of these
              instead:
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {HELPFUL_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="px-6 py-2 rounded-full bg-black text-yellow-500 font-semibold hover:bg-gray-800 transition"
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
