import React from "react";
import { NavLink } from "react-router-dom";
import { FaHouse, FaCoins, FaLocationDot, FaCircleQuestion } from "react-icons/fa6";
import "./Mobile-Bottom-Nav-Component.css";

// Custom glyph: a person WEARING a gold chain — complete round head over
// solid shoulders (FaUser-style weight, ~matches the FA neighbors' ink),
// with the chain beads + medallion pendant cut out of the chest via
// fill-rule="evenodd" so they stay transparent on any chip background.
// No stock icon shows jewelry actually worn; the previous display-bust
// glyph (GiNecklaceDisplay) read as headless at tab size.
function NecklaceWornIcon(props) {
  return (
    <svg viewBox="0 0 512 512" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      {/* head — complete circle */}
      <path d="M256 28a104 104 0 1 0 .1 0z" />
      {/* shoulders/chest with necklace cutouts */}
      <path
        fillRule="evenodd"
        d="M96 512c0-104 66-178 160-178s160 74 160 178z
           M181 374a15 15 0 1 0 30 0a15 15 0 1 0-30 0z
           M205 408a15 15 0 1 0 30 0a15 15 0 1 0-30 0z
           M241 422a15 15 0 1 0 30 0a15 15 0 1 0-30 0z
           M277 408a15 15 0 1 0 30 0a15 15 0 1 0-30 0z
           M301 374a15 15 0 1 0 30 0a15 15 0 1 0-30 0z
           M232 474a24 24 0 1 0 48 0a24 24 0 1 0-48 0z"
      />
    </svg>
  );
}

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
  { to: "/pawning", label: "Pawning", Icon: FaCoins },
  // Custom worn-necklace glyph — Filipino buyers shop gold chains/necklaces
  // far more than diamonds, and jewelry ON a person reads clearest.
  { to: "/jewelry-sales", label: "Jewelry", Icon: NecklaceWornIcon },
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
