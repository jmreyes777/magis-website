import React, { useLayoutEffect, useState } from "react";
import { Link } from "react-router-dom";
import "./Footer-User-Component.css";

import { FaFacebookF, FaInstagram } from "react-icons/fa";
import { FaFacebookMessenger } from "react-icons/fa6";
import { MdEmail } from "react-icons/md";

const EMAIL = "magisgoldandgems.pawnshop@gmail.com";
const LS_KEY = "emailProviderPreference"; // "gmail" | "outlook" | "yahoo"

// --- Inline SVG brand marks (no external files needed) ---
const GmailLogo = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    <path fill="#EA4335" d="M24 24 7.2 11.3v25.4c0 1.8 1.4 3.3 3.2 3.3h27.2c1.8 0 3.2-1.5 3.2-3.3V11.3L24 24z"/>
    <path fill="#FBBC05" d="M7.2 11.3 24 24l16.8-12.7c-.6-.5-1.3-.8-2.1-.8H9.3c-.8 0-1.5.3-2.1.8z"/>
    <path fill="#34A853" d="M28 25.8 41.6 36V11.3L28 21.4v4.4z"/>
    <path fill="#4285F4" d="M20 25.8 6.4 36V11.3L20 21.4v4.4z"/>
    <path fill="#fff" d="M24 26 6.4 13.2V36h35.2V13.2L24 26z"/>
  </svg>
);
const OutlookLogo = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    <rect x="8" y="10" width="20" height="28" rx="2" fill="#0A66C2"/>
    <rect x="22" y="14" width="18" height="20" rx="2" fill="#1B88E5"/>
    <path fill="#fff" d="M28 18h6v2h-6zM28 22h10v2H28zM28 26h8v2h-8z"/>
    <circle cx="18" cy="24" r="7" fill="#fff"/>
    <circle cx="18" cy="24" r="4" fill="#0A66C2"/>
  </svg>
);
const YahooLogo = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
    <rect x="6" y="10" width="36" height="28" rx="6" fill="#6A0DAD"/>
    <path fill="#fff" d="M16 16h4l4 8 4-8h4l-6 12v6h-4v-6l-6-12z"/>
  </svg>
);

// Pretty card used in chooser
function ProviderCard({ label, onClick, Logo, bg, hover }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-xl px-4 py-3 text-white ${bg} hover:${hover} transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-400`}
      aria-label={`Choose ${label}`}
    >
      <Logo className="w-8 h-8 shrink-0" />
      <div className="text-left">
        <div className="text-sm font-semibold">{label}</div>
      </div>
    </button>
  );
}

function Footer() {
  // ---- Editable details ----------------------------------------------------
  const socials = [
    { name: "Facebook",  url: "https://www.facebook.com/magispawnshop/",     sr: "Visit us on Facebook",    Icon: FaFacebookF },
    { name: "Messenger", url: "https://m.me/magispawnshop",                  sr: "Message us on Messenger", Icon: FaFacebookMessenger },
    { name: "Instagram", url: "https://www.instagram.com/magisgoldandgems/", sr: "See us on Instagram",     Icon: FaInstagram },
    { name: "Email",     url: `mailto:${EMAIL}`,                             sr: "Email us",                Icon: MdEmail },
  ];

  const phones = [{ label: "Globe", number: "0962-061-8672" }];
  // Live-chat entry points — branches list (per-branch chat) and the
  // customer-support chat on the contact page.
  const chatLinks = [
    { label: "Branch Live Chat", to: "/branches", sr: "Open the branches list to chat with a branch" },
    { label: "Customer Support", to: "/contact-us", sr: "Open the customer support live chat" },
  ];
  const email = "";

  const headOffice = {
    name: "",
    street: "3rd Floor, LVNG Building",
    area: "Aniceto Gueco Street, Barangay Balibago",
    city: "Angeles City, Pampanga 2009",
    country: "Philippines",
    mapsQuery: "https://maps.app.goo.gl/NhG7VPhPPXv7zeWR6",
  };
  // ------------------------------------------------------------------------

  // SEO prerender hydration safety: the first render must be deterministic
  // (identical to the build-time snapshot), so client-specific values (UA,
  // localStorage) start at their defaults and sync in useLayoutEffect — which
  // runs BEFORE paint, so users never see the intermediate frame. CSR-only
  // visits behave the same way (the sync happens pre-paint on mount).
  const [isMobile, setIsMobile] = useState(false);
  const [showChooser, setShowChooser] = useState(false);
  const [remember, setRemember] = useState(true);
  const [pref, setPref] = useState("");
  useLayoutEffect(() => {
    if (/Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent || "")) {
      setIsMobile(true);
    }
    try {
      const saved = localStorage.getItem(LS_KEY) || "";
      if (saved) setPref(saved);
    } catch { /* storage unavailable → keep defaults */ }
  }, []);

  const composeUrl = (provider, to) => {
    switch (provider) {
      case "gmail":
        return `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(to)}`;
      case "outlook":
        return `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}`;
      case "yahoo":
        return `https://compose.mail.yahoo.com/?to=${encodeURIComponent(to)}`;
      default:
        return `mailto:${to}`;
    }
  };

  // Robust opener: window.open → <a target=_blank> → same-tab
  const openInNewTab = (url) => {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (win && !win.closed) return;
    try {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    } catch {}
    try { window.location.href = url; } catch {}
  };

  const openProvider = (provider) => {
    const url = composeUrl(provider, EMAIL);
    if (provider === "gmail" || provider === "outlook" || provider === "yahoo") {
      openInNewTab(url);
    } else {
      window.location.href = url; // native handler
    }
  };

  const handleEmailClick = (e) => {
    e.preventDefault();

    if (isMobile) {
      window.location.href = `mailto:${EMAIL}`;
      return;
    }
    if (pref) {
      openProvider(pref);
    } else {
      setShowChooser(true);
    }
  };

  const handlePick = (provider) => {
    if (remember) {
      try { localStorage.setItem(LS_KEY, provider); } catch {}
    }
    setPref(provider);
    setShowChooser(false);
    openProvider(provider);
  };

  const handleClearPref = (e) => {
    e.preventDefault();
    try { localStorage.removeItem(LS_KEY); } catch {}
    setPref("");
    setShowChooser(true);
  };

  return (
    <footer className="text-white pt-7 pb-6">
      <div className="max-w-6xl mx-auto px-4">
        {/* Top grid */}
        <div className="footer-columns grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand / Socials */}
          <div className="footer-column space-y-3">
            <picture style={{ display: "contents" }}>
              <source
                srcSet="/images/686421984_954054894279692_2045884033687314189_n.webp"
                type="image/webp"
              />
              <img
                src="/images/686421984_954054894279692_2045884033687314189_n.png"
                alt="Magis Gold & Gems Pawnshop & Jewelry logo"
                className="footer-logo"
                loading="lazy"
              />
            </picture>
            <p className="footer-copy">
              BSP-regulated pawnshop ang Magis Gold & Gems. Transparent na rates at
              friendly na serbisyo — ’yan ang commitment namin sa’yo.
            </p>

            <div className="social-icons">
              {socials.map(({ name, url, sr, Icon }) => {
                const isMail = name === "Email";
                if (isMail) {
                  return (
                    <a
                      key={name}
                      href="#"
                      aria-label={sr}
                      onClick={handleEmailClick}
                      title={pref ? `Compose with ${pref[0].toUpperCase()}${pref.slice(1)}` : "Email us"}
                    >
                      <Icon className="social-icon-vector" aria-hidden="true" />
                    </a>
                  );
                }
                return (
                  <a
                    key={name}
                    href={url}
                    aria-label={sr}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={sr}
                  >
                    <Icon className="social-icon-vector" aria-hidden="true" />
                  </a>
                );
              })}
            </div>

            {/* Tiny link to change provider (desktop only) */}
            {!isMobile && (
              <div className="mt-2 text-xs text-gray-300">
                {pref ? (
                  <>
                    Email opens with <span className="font-semibold">{pref}</span>.{" "}
                    <button
                      type="button"
                      onClick={handleClearPref}
                      className="underline hover:text-white"
                    >
                      Change email app
                    </button>
                  </>
                ) : (
                  <span></span>
                )}
              </div>
            )}
          </div>

          {/* Quick Links */}
          <div className="footer-column">
            <h4>QUICK LINKS</h4>
            <ul>
              {/* SEO W2: dead "/about" link (it 404'd) replaced with the guide
                  hub — sitewide internal links to the keyword-targeted guides. */}
              <li><Link to="/branches">Branch Finder</Link></li>
              <li><Link to="/faqs">FAQs</Link></li>
              <li><Link to="/guides/how-to-pawn">How to Pawn (Sangla)</Link></li>
              <li><Link to="/guides/gold-prices-appraisal">Gold Prices &amp; Appraisal</Link></li>
              <li><Link to="/guides/gold-karat-guide">Gold Karat Guide</Link></li>
              <li><Link to="/guides/pawnshop-interest-rates">Interest Rates &amp; Tubos</Link></li>
              <li className="pt-2"><Link to="/terms">Terms &amp; Conditions</Link></li>
              <li><Link to="/privacy-policy">Privacy Policy</Link></li>
            </ul>
          </div>

          {/* Contact Us */}
          <div className="footer-column">
            <h4>CONTACT US</h4>
            <ul className="footer-contact-list">
              {phones.map((p) => (
                <li key={p.label}>
                  <span className="footer-contact-label">{p.label}:</span>
                  <a href={`tel:${p.number.replace(/[^\d+]/g, "")}`}>{p.number}</a>
                </li>
              ))}
              {chatLinks.map((c) => (
                <li key={c.label}>
                  <Link to={c.to} aria-label={c.sr} className="footer-chat-link">
                    <span className="footer-chat-dot" aria-hidden="true" />
                    {c.label}
                  </Link>
                </li>
              ))}
              {email && (
                <li>
                  <span className="footer-contact-label">Email:</span>
                  <a href={`mailto:${email}`}>{email}</a>
                </li>
              )}
            </ul>
          </div>

          {/* Head Office */}
          <div className="footer-column">
            <h4>HEAD OFFICE</h4>
            <address className="not-italic footer-copy">
              <div>{headOffice.name}</div>
              <div>{headOffice.street}</div>
              <div>{headOffice.area}</div>
              <div>
                {headOffice.city}
                <br />
                {headOffice.country}
              </div>
            </address>

            <div className="pt-3">
              <a
                href={headOffice.mapsQuery}
                target="_blank"
                rel="noopener noreferrer"
                className="map-button"
                aria-label="Open head office in Google Maps"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.5 11.79 7.01 12.29.26.26.68.26.94 0C13.5 21.79 20 15.25 20 10c0-4.42-3.58-8-8-8Zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
                  />
                </svg>
                View on Google Maps
              </a>
            </div>
          </div>
        </div>

        {/* Divider */}
        <hr className="footer-divider" />

        {/* Bottom row */}
        <div className="footer-bottom footer-bottom-row">
          {/* suppressHydrationWarning: a snapshot built on Dec 31 hydrated on
              Jan 1 differs only in this year digit — never worth a hydration
              error; React swaps in the client year on the next render. */}
          <p suppressHydrationWarning>
            &copy; {new Date().getFullYear()} Magis Gold &amp; Gems Pawnshop &amp; Jewelry.
            All rights reserved.
          </p>
          <p>
            Regulated by the Bangko Sentral ng Pilipinas |{" "}
            <a href="https://www.bsp.gov.ph" target="_blank" rel="noopener noreferrer">
              www.bsp.gov.ph
            </a>{" "}
            |{" "}
            <a href="mailto:consumeraffairs@bsp.gov.ph">consumeraffairs@bsp.gov.ph</a>
          </p>
        </div>
      </div>

      {/* ✨ Beautiful chooser (desktop only) */}
      {!isMobile && showChooser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white text-gray-900 rounded-2xl shadow-2xl w-[92%] max-w-lg p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold">Choose your email app</h3>
                <p className="text-sm text-gray-600 mt-1">
                  We’ll use this whenever you click the Email button.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <ProviderCard
                label="Gmail (web)"
                onClick={() => handlePick("gmail")}
                Logo={GmailLogo}
                bg="bg-[#DB4437]"         // Google red
                hover="bg-[#c33c31]"
              />
              <ProviderCard
                label="Outlook (web)"
                onClick={() => handlePick("outlook")}
                Logo={OutlookLogo}
                bg="bg-[#0A66C2]"         // Outlook/LinkedIn blue hue
                hover="bg-[#095aa9]"
              />
              <ProviderCard
                label="Yahoo Mail (web)"
                onClick={() => handlePick("yahoo")}
                Logo={YahooLogo}
                bg="bg-[#6A0DAD]"         // Yahoo purple
                hover="bg-[#5e0ca0]"
              />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember my choice
              </label>

              <button
                type="button"
                className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50"
                onClick={() => setShowChooser(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </footer>
  );
}

export default Footer;
