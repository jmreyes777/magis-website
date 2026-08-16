import React from "react";
import { NavLink } from "react-router-dom";
import { FaHouse, FaPesoSign, FaLocationDot, FaCircleQuestion } from "react-icons/fa6";
import { GiNecklaceDisplay } from "react-icons/gi";
import "./Mobile-Bottom-Nav-Component.css";

// Mobile-only sticky bottom navigation (app-style tab bar).
//
// Rendered unconditionally on every route and hidden ≥768px in CSS — no JS
// viewport branch, so the prerendered snapshot and the first client render are
// byte-identical (hydration-safe) and there is zero layout flash. The bar is
// position:fixed, so it adds no CLS; the matching body padding that keeps it
// from covering page content lives in the same stylesheet.
//
// Collision offsets for the OTHER fixed bottom-anchored widgets (chat launcher,
// chat box/overlay, CSAT toast) are also centralized in the stylesheet rather
// than scattered through their own CSS files.
const NAV_ITEMS = [
  { to: "/", label: "Home", Icon: FaHouse, end: true },
  // Philippine Peso sign (₱) — pawning is a peso-loan service, so the
  // currency glyph is the clearest shorthand for Filipino users.
  { to: "/pawning", label: "Pawning", Icon: FaPesoSign },
  // Gold chain on a display bust over a diamond glyph — Filipino buyers shop
  // gold chains/necklaces far more than diamonds. GiNecklaceDisplay was picked
  // by measured ink coverage (41% at tab size vs GiNecklace's thin 18%), so it
  // holds its visual weight next to the solid FA glyphs (49–65%).
  { to: "/jewelry-sales", label: "Jewelry", Icon: GiNecklaceDisplay },
  { to: "/branches", label: "Branches", Icon: FaLocationDot },
  { to: "/faqs", label: "FAQs", Icon: FaCircleQuestion },
];

function MobileBottomNav() {
  return (
    <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
      {NAV_ITEMS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `mobile-bottom-nav__item${isActive ? " mobile-bottom-nav__item--active" : ""}`
          }
        >
          <Icon className="mobile-bottom-nav__icon" aria-hidden="true" />
          <span className="mobile-bottom-nav__label">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export default MobileBottomNav;
