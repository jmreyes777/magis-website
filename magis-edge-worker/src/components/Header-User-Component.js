import React, { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import './Header-User-Component.css';

function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setIsMenuOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleMenu = () => setIsMenuOpen(!isMenuOpen);

  return (
    <nav className="header-nav">
      <h1 id="logo" className="text-2xl font-bold">
        <NavLink to="/" className="logo-link hover:text-yellow-400">
          Magis Project
        </NavLink>
      </h1>

      {/* Hamburger Button */}
      <button
        className={`hamburger ${isMenuOpen ? 'open' : ''}`}
        onClick={toggleMenu}
        aria-label="Toggle navigation menu"
      >
        <span className="line"></span>
        <span className="line"></span>
        <span className="line"></span>
      </button>

      {/* Navigation Links */}
      <ul
        className={`nav-links ${isMenuOpen ? 'show-menu' : ''} md:flex md:gap-8`}
        onClick={() => setIsMenuOpen(false)} // Close menu on link click for small screens
      >
        <li>
          <NavLink
            to="/"
            exact="true"
            className="links hover:text-yellow-400"
            activeClassName="active-link"
          >
            Home
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/services"
            className="links hover:text-yellow-400"
            activeClassName="active-link"
          >
            Services
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/learn-more"
            className="links hover:text-yellow-400"
            activeClassName="active-link"
          >
            Learn More
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/contact-us"
            className="links hover:text-yellow-400"
            activeClassName="active-link"
          >
            Contact Us
          </NavLink>
        </li>
      </ul>
    </nav>
  );
}

export default Header;