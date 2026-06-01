import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { FaFacebookF, FaInstagram } from "react-icons/fa";
import { FaFacebookMessenger } from "react-icons/fa6";
import { MdEmail } from "react-icons/md";
import './Header-User-Component.css';

function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // Desktop hover menus
  const [showPawningMenu, setShowPawningMenu] = useState(false);
  const [showJewelryMenu, setShowJewelryMenu] = useState(false);

  // Mobile expand/collapse toggles
  const [pawningOpenMobile, setPawningOpenMobile] = useState(false);
  const [jewelryOpenMobile, setJewelryOpenMobile] = useState(false);

  // Which section is currently in view (for crumbs)
  const [sectionInView, setSectionInView] = useState({ page: '', id: '' });

  const location = useLocation();
  const observerRef = useRef(null);

  // ✅ NEW: socials for header drawer
  const SOCIALS = [
    { name: 'Facebook',  href: 'https://www.facebook.com/magispawnshop/',     Icon: FaFacebookF,         sr: 'Visit us on Facebook' },
    { name: 'Messenger', href: 'http://m.me/magispawnshop',                   Icon: FaFacebookMessenger, sr: 'Message us on Messenger' },
    { name: 'Instagram', href: 'https://www.instagram.com/magisgoldandgems/', Icon: FaInstagram,         sr: 'See us on Instagram' },
  ];
  const SUPPORT_EMAIL = 'magisgoldandgems.pawnshop@gmail.com';

  // --- constants ---
  const PAWNING_SECTIONS = [
    { id: 'how-to-pawn', label: 'How to Pawn' },
    { id: 'accepted-items', label: 'Accepted Items' },
    { id: 'how-to-renew', label: 'Renewal' },
    { id: 'how-to-redeem', label: 'Redemption' },
    { id: 'terms-and-conditions', label: 'Terms & Conditions' },
  ];

  // New: Jewelry Sales sections to match the page you created
  const JEWELRY_SECTIONS = [
    { id: 'item-types', label: 'Jewelry Types' },
    { id: 'layaway', label: 'Layaway' },
    { id: 'faqs', label: 'FAQs' },
    { id: 'terms-and-conditions', label: 'Terms & Conditions' },
  ];

  const LABELS = {
    '/': 'Home',
    '/branches': 'Branches',
    '/pawning': 'Pawning',
    '/jewelry-sales': 'Jewelry Sales',
    '/services': 'Services',
    '/services/pawning': 'Pawning',
    '/services/jewelry-sales': 'Jewelry Sales',
    '/about-us': 'About Us',
    '/faqs': 'FAQs',
    '/contact-us': 'Contact Us',
    '/privacy-policy': 'Privacy Policy',
    '/terms': 'Terms & Conditions',
  };

  // --- effects ---
  // Resize: switch mobile/desktop behaviors
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) {
        setIsMenuOpen(false);
        setPawningOpenMobile(false);
        setJewelryOpenMobile(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Esc to close menus
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
        setShowPawningMenu(false);
        setShowJewelryMenu(false);
        setPawningOpenMobile(false);
        setJewelryOpenMobile(false);
        setShowEmailChooser(false); // close popup on ESC too
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, []);

  // Close drawer on route change
  useEffect(() => {
    setIsMenuOpen(false);
    setShowPawningMenu(false);
    setShowJewelryMenu(false);
    setPawningOpenMobile(false);
    setJewelryOpenMobile(false);
  }, [location.pathname]);

  // Body class for backdrop/nudge
  useEffect(() => {
    document.body.classList.toggle('menu-open', isMenuOpen);
    return () => document.body.classList.remove('menu-open');
  }, [isMenuOpen]);

  // Breadcrumb section tracking on /pawning and /jewelry-sales
  useEffect(() => {
    const path = location.pathname;
    let page = '';
    let SECTIONS = [];

    if (path.startsWith('/pawning')) {
      page = 'pawning';
      SECTIONS = PAWNING_SECTIONS;
    } else if (path.startsWith('/jewelry-sales')) {
      page = 'jewelry';
      SECTIONS = JEWELRY_SECTIONS;
    } else {
      setSectionInView({ page: '', id: '' });
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      return;
    }

    const ids = SECTIONS.map((s) => s.id);
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);

    if (els.length === 0) {
      const t = setTimeout(() => {
        const again = ids.map((id) => document.getElementById(id)).filter(Boolean);
        if (again.length) setupObserver(again, page);
      }, 0);
      return () => clearTimeout(t);
    }

    setupObserver(els, page);

    function setupObserver(targets, currentPage) {
      if (observerRef.current) observerRef.current.disconnect();
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

          if (visible) {
            const id = visible.target.id;
            setSectionInView((prev) => {
              if (prev.id !== id || prev.page !== currentPage) {
                const url = new URL(window.location.href);
                url.hash = id;
                window.history.replaceState({}, '', url);
              }
              return { page: currentPage, id };
            });
          }
        },
        {
          root: null,
          rootMargin: '-20% 0px -55% 0px',
          threshold: [0.1, 0.25, 0.5, 0.75],
        }
      );
      targets.forEach((el) => observer.observe(el));
      observerRef.current = observer;
    }

    return () => {
      if (observerRef.current) observerRef.current.disconnect();
      observerRef.current = null;
    };
  }, [location.pathname]);

  // --- helpers ---
  const toggleMenu = () => setIsMenuOpen((o) => !o);
  const closeMenu = () => setIsMenuOpen(false);

  const navLinkClass = ({ isActive }) =>
    `links hover:text-yellow-400 ${isActive ? 'active-link' : ''}`;

  // Breadcrumbs
  const pathnames = location.pathname.split('/').filter(Boolean);
  const segments = pathnames.map((_, i) => '/' + pathnames.slice(0, i + 1).join('/'));
  const crumbs = [
    { label: 'Home', href: '/' },
    ...segments.map((href) => ({
      href,
      label:
        LABELS[href] ||
        href.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    })),
  ];

  if (location.pathname.startsWith('/pawning') && sectionInView.page === 'pawning' && sectionInView.id) {
    const sec = PAWNING_SECTIONS.find((s) => s.id === sectionInView.id);
    if (sec) crumbs.push({ href: `/pawning#${sec.id}`, label: sec.label });
  }

  if (location.pathname.startsWith('/jewelry-sales') && sectionInView.page === 'jewelry' && sectionInView.id) {
    const sec = JEWELRY_SECTIONS.find((s) => s.id === sectionInView.id);
    if (sec) crumbs.push({ href: `/jewelry-sales#${sec.id}`, label: sec.label });
  }

  const currentTitle = crumbs[crumbs.length - 1]?.label || 'Home';

  // used to blend the "+" buttons with their row highlight on mobile
  const pawningActive = location.pathname.startsWith('/pawning');
  const jewelryActive = location.pathname.startsWith('/jewelry-sales');

  /* ==========================
     📧 Minimal email popup
     ========================== */
  const [showEmailChooser, setShowEmailChooser] = useState(false);

  const handleEmailIconClick = (e) => {
    e.preventDefault();
    setShowEmailChooser(true);
  };

  const composeUrl = (provider, to) => {
    switch (provider) {
      case 'gmail':   return `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(to)}`;
      case 'outlook': return `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}`;
      case 'yahoo':   return `https://compose.mail.yahoo.com/?to=${encodeURIComponent(to)}`;
      default:        return `mailto:${to}`;
    }
  };

  const openProvider = (provider) => {
    const url = composeUrl(provider, SUPPORT_EMAIL);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win || win.closed) {
      // Fallback if popup blocked
      window.location.href = url;
    }
    setShowEmailChooser(false);
  };

  return (
  <>
    {/* Primary top bar */}
    <nav className="header-nav">
      <NavLink to="/" className="header-logo-container" onClick={closeMenu}>
        <img
          src="/images/686421984_954054894279692_2045884033687314189_n.png"
          alt="Magis Gold & Gems Pawnshop & Jewellery"
          className="header-logo"
        />
      </NavLink>

      {/* Hamburger (mobile) */}
      <button
        className={`hamburger ${isMenuOpen ? 'open' : ''}`}
        onClick={toggleMenu}
        aria-label="Toggle navigation menu"
        aria-expanded={isMenuOpen}
        aria-controls="primary-navigation"
      >
        <span className="line"></span>
        <span className="line"></span>
        <span className="line"></span>
      </button>

      {/* Nav list (desktop) / Drawer (mobile) */}
      <ul
        id="primary-navigation"
        className={`nav-links ${isMenuOpen ? 'show-menu' : ''} md:flex md:gap-8`}
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile && isMenuOpen ? 'true' : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button (mobile) */}
        {isMobile && isMenuOpen && (
          <button
            type="button"
            className="drawer-close"
            aria-label="Close menu"
            onClick={(e) => {
              e.stopPropagation();
              closeMenu();
            }}
          >
            ×
          </button>
        )}

        <li>
          <NavLink to="/" end className={navLinkClass} onClick={closeMenu}>
            Home
          </NavLink>
        </li>

        <li>
          <NavLink to="/branches" className={navLinkClass} onClick={closeMenu}>
            Branches
          </NavLink>
        </li>

        {/* ===== Pawning (submenu) ===== */}
        <li
          className={`pawning-group ${isMobile ? '' : 'has-sub'}`}
          onMouseEnter={() => !isMobile && setShowPawningMenu(true)}
          onMouseLeave={() => !isMobile && setShowPawningMenu(false)}
          style={{ position: 'relative' }}
        >
          {/* Desktop: link + hover dropdown */}
          {!isMobile && (
            <>
              <NavLink
                to="/pawning"
                className={({ isActive }) =>
                  `links hover:text-yellow-400 ${isActive ? 'active-link' : ''} has-sub`
                }
              >
                Pawning
              </NavLink>

              <ul
                className="submenu-list"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  minWidth: 260,
                  background: '#111213',
                  color: '#fff',
                  borderRadius: 8,
                  padding: '8px 0',
                  boxShadow: '0 10px 24px rgba(0,0,0,0.25)',
                  transform: showPawningMenu ? 'scale(1)' : 'scale(0.98)',
                  opacity: showPawningMenu ? 1 : 0,
                  pointerEvents: showPawningMenu ? 'auto' : 'none',
                  transition: 'opacity .15s ease, transform .15s ease',
                  zIndex: 10005,
                }}
              >
                {PAWNING_SECTIONS.map(({ id, label }) => (
                  <li key={id}>
                    <NavLink
                      to={{ pathname: '/pawning', hash: `#${id}` }}
                      className="links"
                      onClick={closeMenu}
                      style={{
                        display: 'block',
                        padding: '10px 14px',
                        color: '#e5e7eb',
                        textTransform: 'none',
                        letterSpacing: 0,
                        fontSize: '0.95rem',
                        borderBottom: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Mobile: Pawning row + single "+" toggle */}
          {isMobile && (
            <>
              <div
                className={`drawer-row ${pawningOpenMobile ? 'open' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  width: '100%',
                  gap: 0,
                  background:
                    pawningActive || pawningOpenMobile ? 'rgba(241,196,15,0.12)' : 'transparent',
                }}
              >
                <NavLink
                  to="/pawning"
                  className={navLinkClass}
                  onClick={closeMenu}
                  style={{
                    flex: 1,
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                  }}
                >
                  Pawning
                </NavLink>

                {/* Only one + button (no has-sub on the link) */}
                <button
                  type="button"
                  className={`drawer-toggle ${pawningOpenMobile ? 'open' : ''}`}
                  aria-label={pawningOpenMobile ? 'Collapse pawning sections' : 'Expand pawning sections'}
                  aria-expanded={pawningOpenMobile}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPawningOpenMobile((o) => !o);
                  }}
                  style={{
                    flex: '0 0 56px',
                    display: 'grid',
                    placeItems: 'center',
                    background:
                      pawningActive || pawningOpenMobile ? 'rgba(241,196,15,0.12)' : 'transparent',
                    color: '#e5e7eb',
                    borderLeft: '1px solid rgba(255,255,255,0.08)',
                    borderTopRightRadius: 8,
                    borderBottomRightRadius: 8,
                  }}
                >
                  {pawningOpenMobile ? '–' : '+'}
                </button>
              </div>

              {pawningOpenMobile && (
                <ul id="pawning-submenu-mobile" style={{ width: '100%' }}>
                  {PAWNING_SECTIONS.map(({ id, label }) => (
                    <li key={id}>
                      <NavLink
                        to={{ pathname: '/pawning', hash: `#${id}` }}
                        className="links"
                        onClick={closeMenu}
                        style={{
                          paddingLeft: 16,
                          textTransform: 'none',
                          letterSpacing: 0,
                          fontSize: '0.95rem',
                        }}
                      >
                        {label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </li>
        {/* ===== End Pawning ===== */}

        {/* ===== Jewelry Sales (submenu) ===== */}
        <li
          className={`jewelry-group ${isMobile ? '' : 'has-sub'}`}
          onMouseEnter={() => !isMobile && setShowJewelryMenu(true)}
          onMouseLeave={() => !isMobile && setShowJewelryMenu(false)}
          style={{ position: 'relative' }}
        >
          {/* Desktop: link + hover dropdown */}
          {!isMobile && (
            <>
              <NavLink
                to="/jewelry-sales"
                className={({ isActive }) =>
                  `links hover:text-yellow-400 ${isActive ? 'active-link' : ''} has-sub`
                }
              >
                Jewelry Sales
              </NavLink>

              <ul
                className="submenu-list"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  minWidth: 260,
                  background: '#111213',
                  color: '#fff',
                  borderRadius: 8,
                  padding: '8px 0',
                  boxShadow: '0 10px 24px rgba(0,0,0,0.25)',
                  transform: showJewelryMenu ? 'scale(1)' : 'scale(0.98)',
                  opacity: showJewelryMenu ? 1 : 0,
                  pointerEvents: showJewelryMenu ? 'auto' : 'none',
                  transition: 'opacity .15s ease, transform .15s ease',
                  zIndex: 10005,
                }}
              >
                {JEWELRY_SECTIONS.map(({ id, label }) => (
                  <li key={id}>
                    <NavLink
                      to={{ pathname: '/jewelry-sales', hash: `#${id}` }}
                      className="links"
                      onClick={closeMenu}
                      style={{
                        display: 'block',
                        padding: '10px 14px',
                        color: '#e5e7eb',
                        textTransform: 'none',
                        letterSpacing: 0,
                        fontSize: '0.95rem',
                        borderBottom: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Mobile: Jewelry row + single "+" toggle */}
          {isMobile && (
            <>
              <div
                className={`drawer-row ${jewelryOpenMobile ? 'open' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  width: '100%',
                  gap: 0,
                  background:
                    jewelryActive || jewelryOpenMobile ? 'rgba(241,196,15,0.12)' : 'transparent',
                }}
              >
                <NavLink
                  to="/jewelry-sales"
                  className={navLinkClass}
                  onClick={closeMenu}
                  style={{
                    flex: 1,
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                  }}
                >
                  Jewelry Sales
                </NavLink>

                {/* Only one + button (no has-sub on the link) */}
                <button
                  type="button"
                  className={`drawer-toggle ${jewelryOpenMobile ? 'open' : ''}`}
                  aria-label={jewelryOpenMobile ? 'Collapse jewelry sections' : 'Expand jewelry sections'}
                  aria-expanded={jewelryOpenMobile}
                  onClick={(e) => {
                    e.stopPropagation();
                    setJewelryOpenMobile((o) => !o);
                  }}
                  style={{
                    flex: '0 0 56px',
                    display: 'grid',
                    placeItems: 'center',
                    background:
                      jewelryActive || jewelryOpenMobile ? 'rgba(241,196,15,0.12)' : 'transparent',
                    color: '#e5e7eb',
                    borderLeft: '1px solid rgba(255,255,255,0.08)',
                    borderTopRightRadius: 8,
                    borderBottomRightRadius: 8,
                  }}
                >
                  {jewelryOpenMobile ? '–' : '+'}
                </button>
              </div>

              {jewelryOpenMobile && (
                <ul id="jewelry-submenu-mobile" style={{ width: '100%' }}>
                  {JEWELRY_SECTIONS.map(({ id, label }) => (
                    <li key={id}>
                      <NavLink
                        to={{ pathname: '/jewelry-sales', hash: `#${id}` }}
                        className="links"
                        onClick={closeMenu}
                        style={{
                          paddingLeft: 16,
                          textTransform: 'none',
                          letterSpacing: 0,
                          fontSize: '0.95rem',
                        }}
                      >
                        {label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </li>
        {/* ===== End Jewelry Sales ===== */}

        <li>
          <NavLink to="/about-us" className={navLinkClass} onClick={closeMenu}>
            About Us
          </NavLink>
        </li>

        <li>
          <NavLink to="/faqs" className={navLinkClass} onClick={closeMenu}>
            FAQs
          </NavLink>
        </li>

        {/* ✅ Socials + email BELOW FAQs (mobile only) */}
        {isMobile && (
          <li className="drawer-socials">
            <a
              href="https://www.facebook.com/magispawnshop/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Visit us on Facebook"
              className="drawer-social-btn"
            >
              <FaFacebookF className="drawer-social-icon" aria-hidden="true" />
            </a>

            <a
              href="http://m.me/magispawnshop"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Message us on Messenger"
              className="drawer-social-btn"
            >
              <FaFacebookMessenger className="drawer-social-icon" aria-hidden="true" />
            </a>

            <a
              href="https://www.instagram.com/magisgoldandgems/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="See us on Instagram"
              className="drawer-social-btn"
            >
              <FaInstagram className="drawer-social-icon" aria-hidden="true" />
            </a>

            {/* 📧 Email icon -> open minimal popup chooser */}
            <a
              href="#"
              onClick={handleEmailIconClick}
              aria-label="Email us"
              className="drawer-social-btn"
            >
              <MdEmail className="drawer-social-icon" aria-hidden="true" />
            </a>
          </li>
        )}
      </ul>
    </nav>

    {/* Backdrop for the mobile drawer */}
    <div
      className={`menu-backdrop ${isMenuOpen ? 'show' : ''}`}
      onClick={closeMenu}
      aria-hidden={!isMenuOpen}
    />

    {/* Secondary bar (breadcrumbs only) */}
    <div className="subnav">
      <div className="wrap">
        <nav aria-label="Breadcrumb">
          <ol className="breadcrumbs">
            {crumbs.map((crumb, idx) => {
              const isLast = idx === crumbs.length - 1;
              return (
                <li key={`${crumb.href}-${idx}`}>
                  {!isLast ? (
                    <>
                      <NavLink to={crumb.href}>{crumb.label}</NavLink>
                      <span className="sep">›</span>
                    </>
                  ) : (
                    <span className="current" aria-current="page">
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </div>
    </div>

    {/* ==========================
        📧 Minimal chooser popup
        ========================== */}
    {showEmailChooser && (
      <div
        className="fixed inset-0 z-[11000] flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        role="dialog"
        aria-modal="true"
        onClick={() => setShowEmailChooser(false)}
      >
        <div
          className="bg-white text-gray-900 rounded-2xl shadow-2xl w-[92%] max-w-md p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-lg font-bold">Choose your email app</h3>
          <p className="text-sm text-gray-600 mt-1 mb-4">
            We’ll open a new tab to compose to {SUPPORT_EMAIL}.
          </p>

          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={() => openProvider('gmail')}
              className="w-full rounded-xl px-4 py-3 bg-[#DB4437] hover:bg-[#c33c31] text-white text-sm font-semibold transition"
            >
              Gmail (web)
            </button>
            <button
              type="button"
              onClick={() => openProvider('outlook')}
              className="w-full rounded-xl px-4 py-3 bg-[#0A66C2] hover:bg-[#095aa9] text-white text-sm font-semibold transition"
            >
              Outlook (web)
            </button>
            <button
              type="button"
              onClick={() => openProvider('yahoo')}
              className="w-full rounded-xl px-4 py-3 bg-[#6A0DAD] hover:bg-[#5e0ca0] text-white text-sm font-semibold transition"
            >
              Yahoo Mail (web)
            </button>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setShowEmailChooser(false)}
              className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}
  </>
);
}

export default Header;
