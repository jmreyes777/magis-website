import React, { useState, useEffect } from 'react';
import Footer from '../components/Footer-User-Component';
import {
  FaMoneyBillAlt,
  FaGavel,
  FaPercent,
  FaCertificate,
  FaClock,
  FaArrowRight,
  FaUserCircle,
  FaMapMarkerAlt,
  FaComments
} from 'react-icons/fa';
import { Link } from "react-router-dom";
import { Helmet } from 'react-helmet-async';
import './Home-User-Page.css';

// 🔗 Firestore (client SDK)
import { db } from '../firebase-config';
import { doc, onSnapshot, getDoc } from 'firebase/firestore';

// 🔗 Facebook album grid (auto-fetches latest album if no ID)
import FacebookAlbumCarousel from '../components/FacebookAlbumCarousel';

function Home() {
  const handleFindBranch = () => {
    window.location.href = '/branches';
  };

  const handleOpenChat = () => {
    // Open the chat widget - this will trigger the chat box
    const chatWidget = document.querySelector('[class*="guest-chat-box"]');
    if (chatWidget) {
      // If chat widget exists, scroll to it or trigger it
      window.location.href = '/branches';
    } else {
      // Navigate to branches where chat is available
      window.location.href = '/branches';
    }
  };

  // ---- Helpers ----
  const AUCTION_DAY = 15;

  // Fallback: compute next 15th at 00:00 local time
  const computeNextAuctionFallback = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    return d < AUCTION_DAY
      ? new Date(y, m, AUCTION_DAY, 0, 0, 0, 0)
      : new Date(y, m + 1, AUCTION_DAY, 0, 0, 0, 0);
  };

  // If a configured date is in the past, roll it forward by months
  // until it’s in the future, preserving the day & time.
  // (used as a fallback when we only have a single recurring date)
  const rollForwardIfPast = (base) => {
    const now = new Date();
    let target = new Date(base);
    while (target <= now) {
      target = new Date(
        target.getFullYear(),
        target.getMonth() + 1,
        target.getDate(),
        target.getHours(),
        target.getMinutes(),
        target.getSeconds(),
        0
      );
    }
    return target;
  };

  // Display state for target date (for "Auction Date: …")
  const [nextAuctionDate, setNextAuctionDate] = useState(() => computeNextAuctionFallback());
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  // Read CMS/Firestore-configured date
  useEffect(() => {
    const ref = doc(db, 'siteConfig', 'auction');

    // helper to safely turn Firestore Timestamp / string / number -> Date or null
    const toDateSafe = (value) => {
      if (!value) return null;
      let d = value;
      if (typeof d?.toDate === 'function') d = d.toDate();
      else if (typeof d === 'string' || typeof d === 'number') d = new Date(d);
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
      return d;
    };

    const pickDateFromData = (data) => {
      const now = new Date();

      // 1) Prefer upcomingDates (array of { startAt, endAt?, label? })
      if (Array.isArray(data.upcomingDates) && data.upcomingDates.length) {
        const future = data.upcomingDates
          .map((entry) => toDateSafe(entry?.startAt))
          .filter((d) => d && d > now)
          .sort((a, b) => a - b);

        if (future[0]) {
          return future[0]; // nearest future upcoming date
        }
      }

      // 2) Fallback to single nextAuctionAt (treat as recurring monthly)
      const configured = toDateSafe(data.nextAuctionAt);
      if (configured) {
        return rollForwardIfPast(configured);
      }

      // 3) Final fallback: hard-coded 15th logic
      return computeNextAuctionFallback();
    };

    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setNextAuctionDate(computeNextAuctionFallback());
          return;
        }
        const data = snap.data() || {};
        const chosen = pickDateFromData(data);
        setNextAuctionDate(chosen);
      },
      async (err) => {
        console.warn('[HOME] Firestore onSnapshot failed; falling back to one-time read:', err?.message);
        try {
          const snapOnce = await getDoc(ref);
          if (snapOnce.exists()) {
            const data = snapOnce.data() || {};
            const chosen = pickDateFromData(data);
            setNextAuctionDate(chosen);
            return;
          }
        } catch {
          // ignore and fall through
        }
        setNextAuctionDate(computeNextAuctionFallback());
      }
    );

    return () => unsub();
  }, []);

  // Countdown timer
  useEffect(() => {
    let target = new Date(nextAuctionDate);
    const updateCountdown = () => {
      const now = new Date();
      if (now >= target) {
        // When countdown reaches/passes the target, roll the date forward.
        // For upcomingDates this will be corrected by the Firestore listener
        // once you update the calendar there.
        target = rollForwardIfPast(target);
        setNextAuctionDate(target);
      }

      const diff = Math.max(0, target - now);
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setTimeLeft({ days, hours, minutes, seconds });
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [nextAuctionDate]);

  // Meta tags
  const origin =
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.host}`
      : '';
  const pageUrl = `${origin}/`;
  const ogImage = `${origin}/images/og-home.jpg`;

  return (
    <div className="flex flex-col min-h-screen">
      <Helmet>
        <title>Magis Pawnshop &amp; Jewelry | Instant Cash for Your Gold</title>
        <meta
          name="description"
          content="Trusted pawning, auctions, and jewelry sales since 1996. Get instant cash for your gold with high appraisals, low interest rates, and fast processing."
        />
        <link rel="canonical" href={pageUrl} />
        <meta property="og:title" content="Magis Pawnshop &amp; Jewelry | Instant Cash for Your Gold" />
        <meta property="og:description" content="Trusted pawning, auctions, and jewelry sales since 1996." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={pageUrl} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:site_name" content="Magis Gold & Gem Pawnshop & Jewelry" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Magis Pawnshop & Jewelry | Instant Cash for Your Gold" />
        <meta name="twitter:description" content="Trusted pawning, auctions, and jewelry sales since 1996." />
        <meta name="twitter:image" content={ogImage} />
      </Helmet>

      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-overlay" />
        <div className="hero-content">
          <h1 className="hero-title">
            Instant Cash for Your Gold
          </h1>
          <p className="hero-subtitle">
            Trusted pawning, jewelry sales, and auctions since 1996. Get high appraisals, low interest rates, and fast processing at a branch near you.
          </p>
          <div className="hero-cta-container">
            <button
              onClick={handleFindBranch}
              className="btn-primary-cta"
            >
              <FaMapMarkerAlt className="mr-2" />
              Find a Branch Near You
            </button>
            <button
              onClick={handleOpenChat}
              className="btn-secondary-cta"
            >
              <FaComments className="mr-2" />
              Chat With Our Team
            </button>
          </div>
        </div>
      </section>

      <main className="flex-grow">
        {/* Services Overview */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Our Services</h2>
            <p className="section-subtitle">
              Quick cash for your valuables and quality jewelry at competitive prices
            </p>
          </div>
          <div className="services-grid">
            <div className="service-card">
              <div className="service-icon">
                <FaMoneyBillAlt />
              </div>
              <h3 className="service-title">Pawn Loans</h3>
              <p className="service-description">
                Quick loans for your gold jewelry and valuables with high appraisals and low interest rates.
              </p>
              <Link
                to="/pawning"
                className="service-link"
              >
                Learn More <FaArrowRight />
              </Link>
            </div>
            <div className="service-card">
              <div className="service-icon">
                <FaGavel />
              </div>
              <h3 className="service-title">Jewelry Sales</h3>
              <p className="service-description">
                Unredeemed jewelry at great prices in-store. Browse our collection at any sales branch.
              </p>
              <Link
                to="/jewelry-sales"
                className="service-link"
              >
                View Details <FaArrowRight />
              </Link>
            </div>
          </div>
        </section>

        {/* Value Proposition */}
        <section className="section section-alt">
          <div className="section-header">
            <h2 className="section-title">Why Choose Magis Gold & Gem?</h2>
            <p className="section-subtitle">
              Trusted by Filipinos since 1996 for fair appraisals, low rates, and fast service
            </p>
          </div>
          <div className="benefits-grid">
            <div className="benefit-card">
              <div className="benefit-icon">
                <FaCertificate />
              </div>
              <h3 className="benefit-title">High Appraisal Values</h3>
              <p className="benefit-description">
                Up to 30% higher appraisal for your gold jewelry compared to other pawnshops.
              </p>
            </div>
            <div className="benefit-card">
              <div className="benefit-icon">
                <FaPercent />
              </div>
              <h3 className="benefit-title">Low Interest Rates</h3>
              <p className="benefit-description">
                Affordable rates starting at 1% per month. Save more on your pawn loans.
              </p>
            </div>
            <div className="benefit-card">
              <div className="benefit-icon">
                <FaClock />
              </div>
              <h3 className="benefit-title">Fast Processing</h3>
              <p className="benefit-description">
                Receive cash in as fast as 15 minutes. Quick appraisal and immediate payout.
              </p>
            </div>
          </div>
        </section>

        {/* Auction Highlights */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Next Monthly Auction</h2>
            <p className="section-subtitle">
              Browse unredeemed jewelry and valuables at competitive prices
            </p>
          </div>
          <div className="text-center">
            <p className="text-xl font-semibold mb-4" style={{ color: '#1a1a2e' }}>
              Auction Date:{' '}
              {nextAuctionDate.toLocaleDateString('en-PH', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}
            </p>
            <div className="auction-countdown">
              <div className="countdown-item">
                <div className="countdown-value">{timeLeft.days}</div>
                <div className="countdown-label">Days</div>
              </div>
              <div className="countdown-item">
                <div className="countdown-value">{timeLeft.hours}</div>
                <div className="countdown-label">Hours</div>
              </div>
              <div className="countdown-item">
                <div className="countdown-value">{timeLeft.minutes}</div>
                <div className="countdown-label">Minutes</div>
              </div>
              <div className="countdown-item">
                <div className="countdown-value">{timeLeft.seconds}</div>
                <div className="countdown-label">Seconds</div>
              </div>
            </div>
            <p className="auction-info">
              Auctions are held on the 2
              <sup>nd</sup> week of every month during our sales branch's operating hours.{' '}
              <Link
                to="/branches?filter=jewelry"
                className="service-link"
              >
                See sales branch hours <FaArrowRight />
              </Link>
            </p>

            {/* ⤵️ Automatically fetches the latest Facebook album */}
            <div style={{ marginTop: '48px' }}>
              <FacebookAlbumCarousel pageSize={12} />
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="section section-alt">
          <div className="section-header">
            <h2 className="section-title">How It Works</h2>
            <p className="section-subtitle">
              Get cash for your gold in three simple steps
            </p>
          </div>
          <div className="steps-grid">
            <div className="step-card">
              <div className="step-number">1</div>
              <div className="step-icon">
                <FaUserCircle />
              </div>
              <h3 className="step-title">Bring Your Item</h3>
              <p className="step-description">
                Visit any of our branches with your gold jewelry or valuables.
              </p>
            </div>
            <div className="step-card">
              <div className="step-number">2</div>
              <div className="step-icon">
                <FaPercent />
              </div>
              <h3 className="step-title">Get Appraisal</h3>
              <p className="step-description">
                Our experts appraise your item and offer competitive cash value.
              </p>
            </div>
            <div className="step-card">
              <div className="step-number">3</div>
              <div className="step-icon">
                <FaMoneyBillAlt />
              </div>
              <h3 className="step-title">Receive Cash</h3>
              <p className="step-description">
                Get instant cash with secure storage and peace of mind.
              </p>
            </div>
          </div>
        </section>

        {/* Testimonials */}
        <section className="py-12 bg-white">
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-3xl font-bold mb-6">What Our Customers Say</h2>
            <blockquote className="max-w-xl mx-auto italic text-gray-700 mb-4">
              “I pawned my necklace at Magis and was impressed by the high appraisal and friendly service.
              They even guided me through the auction process when I couldn’t redeem.”
            </blockquote>
            <p className="font-semibold">– Maria G.</p>
          </div>
        </section>

        {/* Final CTA Banner */}
        <section className="py-12 bg-yellow-500">
          <div className="container mx-auto px-4 text-center text-black">
            <h2 className="text-3xl font-bold mb-4">Ready to Get Started?</h2>
            <p className="mb-6">Find a branch near you and chat with our team instantly.</p>
            <button
              onClick={handleFindBranch}
              className="px-8 py-3 bg-black text-yellow-500 font-semibold rounded-full hover:bg-gray-800 transition"
            >
              Find a Branch & Chat
            </button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default Home;
