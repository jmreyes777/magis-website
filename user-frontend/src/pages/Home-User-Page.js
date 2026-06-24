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
import { Link, useNavigate } from "react-router-dom";
import Seo, { SITE_ORIGIN, SITE_NAME } from '../components/Seo';
import './Home-User-Page.css';

// 🔗 Firestore (client SDK)
import { db } from '../firebase-config';
import { doc, onSnapshot, getDoc } from 'firebase/firestore';

// 🔗 Facebook album grid (auto-fetches latest album if no ID)
import FacebookAlbumCarousel from '../components/FacebookAlbumCarousel';

// ===========================================================================
// HOMEPAGE STRUCTURED DATA + ISOLATED AUCTION COUNTDOWN (module scope)
// ===========================================================================

// LocalBusiness structured data for the homepage. Only facts already shown on
// the site — no invented address/phone/opening-hours/ratings (Google penalizes
// fabricated structured data). Add geo/hours later for richer rich-results.
const HOME_JSONLD = {
  '@type': 'LocalBusiness',
  '@id': `${SITE_ORIGIN}/#business`,
  name: SITE_NAME,
  description:
    'Trusted pawning, auctions, and jewelry sales since 1996. High appraisals, low interest rates, and fast processing.',
  url: `${SITE_ORIGIN}/`,
  image: `${SITE_ORIGIN}/logo512.png`,
  logo: `${SITE_ORIGIN}/logo512.png`,
  foundingDate: '1996',
  areaServed: { '@type': 'Country', name: 'Philippines' },
  knowsAbout: ['Pawn loans', 'Gold jewelry', 'Jewelry sales', 'Auctions'],
};

// ---- Auction date helpers ----
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

// If a configured date is in the past, roll it forward by months until it's in
// the future, preserving the day & time.
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

const computeTimeLeft = (target) => {
  const diff = Math.max(0, target - new Date());
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000),
  };
};

// Countdown is isolated in its own component so the 1s tick only re-renders
// this subtree, not the entire landing page.
function AuctionCountdown({ target, onRollover }) {
  const [timeLeft, setTimeLeft] = useState(() => computeTimeLeft(new Date(target)));

  useEffect(() => {
    let current = new Date(target);
    const tick = () => {
      if (new Date() >= current) {
        current = rollForwardIfPast(current);
        if (typeof onRollover === 'function') onRollover(current);
      }
      setTimeLeft(computeTimeLeft(current));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target, onRollover]);

  return (
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
  );
}

function Home() {
  const navigate = useNavigate();

  const handleFindBranch = () => navigate('/branches');

  // Chat is per-branch (the guest picks a branch, then taps its Chat button),
  // so route to the branches page where live chat is available.
  const handleOpenChat = () => navigate('/branches');

  // Target date for the auction display + countdown. The per-second ticking is
  // isolated in <AuctionCountdown/> so the rest of the page stays static.
  const [nextAuctionDate, setNextAuctionDate] = useState(() => computeNextAuctionFallback());

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

  return (
    <div className="flex flex-col min-h-screen">
      <Seo
        title="Magis Pawnshop & Jewelry | Instant Cash for Your Gold"
        description="Trusted pawning, auctions, and jewelry sales since 1996. Get instant cash for your gold with high appraisals, low interest rates, and fast processing."
        path="/"
        jsonLd={HOME_JSONLD}
      />

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
          <div className="hero-trust-strip">
            <span className="hero-trust-item"><FaCertificate /> Trusted since 1996</span>
            <span className="hero-trust-item"><FaPercent /> Rates from 1% / mo</span>
            <span className="hero-trust-item"><FaClock /> Cash in ~15 mins</span>
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
            <h2 className="section-title">Why Choose Magis Gold & Gems?</h2>
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
            <p className="auction-date">
              Auction Date:{' '}
              {nextAuctionDate.toLocaleDateString('en-PH', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}
            </p>
            <AuctionCountdown target={nextAuctionDate} onRollover={setNextAuctionDate} />
            <p className="auction-info">
              Auctions are held monthly during our sales branch's operating hours.{' '}
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
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">What Our Customers Say</h2>
          </div>
          <div className="testimonial-container">
            <blockquote className="testimonial-quote">
              I pawned my necklace at Magis and was impressed by the high appraisal and friendly service.
              They even guided me through the auction process when I couldn’t redeem.
            </blockquote>
            <p className="testimonial-author">– Maria G.</p>
          </div>
        </section>

        {/* Final CTA Banner */}
        <section className="cta-banner">
          <h2 className="cta-banner-title">Ready to Get Started?</h2>
          <p className="cta-banner-subtitle">
            Find a branch near you and chat with our team instantly.
          </p>
          <button
            onClick={handleFindBranch}
            className="cta-banner-btn"
          >
            Find a Branch & Chat
          </button>
        </section>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default Home;
