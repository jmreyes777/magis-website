import React, { useState, useEffect } from 'react';
import Footer from '../components/Footer-User-Component';
import {
  FaMapMarkerAlt,
  FaArrowRight,
  FaCertificate,
  FaBalanceScale,
  FaClock,
  FaHeartbeat,
  FaGraduationCap,
  FaStore,
  FaWallet,
  FaFileInvoiceDollar,
  FaUserShield,
  FaLock
} from 'react-icons/fa';
import { Link } from "react-router-dom";
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
    <div className="home-page flex flex-col min-h-screen">
      <Seo
        title="Magis Pawnshop & Jewelry | Instant Cash for Your Gold"
        description="Trusted pawning, auctions, and jewelry sales since 1996. Get instant cash for your gold with high appraisals, low interest rates, and fast processing."
        path="/"
        jsonLd={HOME_JSONLD}
      />

      {/* Hero */}
      <section className="home-hero">
        <div className="home-shell home-hero__inner">
          <h1 className="home-hero__title">Quick cash using your gold jewelry.</h1>
          <p className="home-hero__sub">
            A secure, private, and fair way to get emergency funds. Walang kaba, walang
            mahabang proseso. Just straightforward service for when you need it most.
          </p>
          <Link to="/branches" className="home-cta">
            <FaMapMarkerAlt aria-hidden="true" /> Find a Branch Near You{' '}
            <FaArrowRight aria-hidden="true" />
          </Link>
          <div className="home-trustline">
            <span><FaCertificate className="mr-2" aria-hidden="true" /> Serving since 1996</span>
            <span><FaBalanceScale className="mr-2" aria-hidden="true" /> Fair appraisals</span>
            <span><FaClock className="mr-2" aria-hidden="true" /> Cash in minutes</span>
          </div>
        </div>
      </section>

      <main className="flex-grow">
        {/* Use cases */}
        <section className="home-section">
          <div className="home-shell">
            <div className="home-section-head">
              <p className="home-eyebrow">Use cases</p>
              <h2 className="home-h2">Practical help for urgent expenses.</h2>
              <p className="home-lead">
                We provide a respectful, no-questions-asked way to get cash immediately
                when life happens.
              </p>
            </div>
            <div className="home-grid">
              <div className="home-cell">
                <span className="home-cell__icon"><FaHeartbeat aria-hidden="true" /></span>
                <h3 className="home-cell__title">Medical needs</h3>
                <p className="home-cell__text">Hospital bills, sudden treatments, or medicines.</p>
              </div>
              <div className="home-cell">
                <span className="home-cell__icon"><FaGraduationCap aria-hidden="true" /></span>
                <h3 className="home-cell__title">Education</h3>
                <p className="home-cell__text">Tuition fees and school requirements.</p>
              </div>
              <div className="home-cell">
                <span className="home-cell__icon"><FaStore aria-hidden="true" /></span>
                <h3 className="home-cell__title">Business relief</h3>
                <p className="home-cell__text">Pandagdag puhunan for your sari-sari store or small business.</p>
              </div>
              <div className="home-cell">
                <span className="home-cell__icon"><FaWallet aria-hidden="true" /></span>
                <h3 className="home-cell__title">Daily expenses</h3>
                <p className="home-cell__text">Bridging the gap during a salary delay.</p>
              </div>
              <div className="home-cell">
                <span className="home-cell__icon"><FaFileInvoiceDollar aria-hidden="true" /></span>
                <h3 className="home-cell__title">Unexpected bills</h3>
                <p className="home-cell__text">Urgent household repairs or due dates.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Process */}
        <section className="home-section home-section--navy">
          <div className="home-shell">
            <div className="home-section-head">
              <p className="home-eyebrow">Process</p>
              <h2 className="home-h2">How the process works.</h2>
              <p className="home-lead">
                A fast, transparent, and no-pressure experience from start to finish.
              </p>
            </div>
            <div className="home-steps">
              <div className="home-step">
                <span className="home-step__num">STEP 1</span>
                <h3 className="home-step__title">Bring your item</h3>
                <p className="home-step__text">Visit any branch with your gold jewelry.</p>
              </div>
              <div className="home-step">
                <span className="home-step__num">STEP 2</span>
                <h3 className="home-step__title">Fair appraisal</h3>
                <p className="home-step__text">We appraise your gold by karat and weight at our posted branch rates and tell you the exact amount you can borrow.</p>
              </div>
              <div className="home-step">
                <span className="home-step__num">STEP 3</span>
                <h3 className="home-step__title">Clear terms</h3>
                <p className="home-step__text">Ipapaliwanag namin nang maayos ang terms at interest rates. Walang hidden charges.</p>
              </div>
              <div className="home-step">
                <span className="home-step__num">STEP 4</span>
                <h3 className="home-step__title">Your decision</h3>
                <p className="home-step__text">You decide whether to proceed. Walang pilitan.</p>
              </div>
              <div className="home-step">
                <span className="home-step__num">STEP 5</span>
                <h3 className="home-step__title">Get your cash</h3>
                <p className="home-step__text">If you accept, receive your funds within minutes.</p>
              </div>
              <div className="home-step">
                <span className="home-step__num">STEP 6</span>
                <h3 className="home-step__title">Redeem securely</h3>
                <p className="home-step__text">Pay the loan amount within the agreed term to get your jewelry back safely.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Trust / privacy / fairness */}
        <section className="home-section">
          <div className="home-shell">
            <div className="home-section-head">
              <p className="home-eyebrow">Privacy</p>
              <h2 className="home-h2">Your privacy is our priority.</h2>
              <p className="home-lead">
                Pawning is a private matter. Our branches and staff are trained to give
                you a discreet and highly professional experience.
              </p>
            </div>
            <div className="home-feature-grid">
              <div className="home-feature">
                <span className="home-feature__icon"><FaUserShield aria-hidden="true" /></span>
                <h3 className="home-feature__title">Discreet service</h3>
                <p className="home-feature__text">Walang usisero. We handle every transaction quietly and respectfully.</p>
              </div>
              <div className="home-feature">
                <span className="home-feature__icon"><FaLock aria-hidden="true" /></span>
                <h3 className="home-feature__title">Secure storage</h3>
                <p className="home-feature__text">Your gold is kept completely safe until the day you redeem it.</p>
              </div>
              <div className="home-feature">
                <span className="home-feature__icon"><FaBalanceScale aria-hidden="true" /></span>
                <h3 className="home-feature__title">Fair rates</h3>
                <p className="home-feature__text">We offer highly competitive appraisals and transparent interest rates starting at 1%</p>
              </div>
            </div>
          </div>
        </section>

        {/* Monthly subasta */}
        <section className="home-section home-section--navy">
          <div className="home-shell">
            <div className="home-section-head">
              <p className="home-eyebrow">Monthly subasta</p>
              <h2 className="home-h2">Clear policies on unredeemed items.</h2>
              <p className="home-lead">
                We understand that financial plans can change. Gusto naming maging malinaw
                sa simula pa lang kung ano ang mangyayari kung hindi mabayaran ang loan.
              </p>
            </div>
            <ul className="home-policy">
              <li>If your loan term expires and you cannot renew or redeem your item, it will be included in our scheduled monthly subasta (auction).</li>
              <li>This is a standard, transparent procedure that allows the pawnshop to recover the unpaid loan amount.</li>
              <li>We ensure all deadlines and policies are clearly explained to you before you sign anything, para walang surprises.</li>
            </ul>

            <div className="home-countdown-wrap">
              <p className="home-countdown-meta">
                Next scheduled subasta
                <strong>
                  {nextAuctionDate.toLocaleDateString('en-PH', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </strong>
              </p>
              <AuctionCountdown target={nextAuctionDate} onRollover={setNextAuctionDate} />
            </div>

            {/* ⤵️ Automatically fetches the latest Facebook album */}
            <div className="home-album">
              <FacebookAlbumCarousel pageSize={12} />
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default Home;
