import React, { useState, useEffect } from 'react';
import Footer from '../components/Footer-User-Component';
import {
  FaMapMarkerAlt,
  FaArrowRight,
  FaCertificate,
  FaBalanceScale,
  FaClock,
  FaUserShield,
  FaLock
} from 'react-icons/fa';
import { Link } from "react-router-dom";
import Seo, { SITE_ORIGIN, SITE_NAME } from '../components/Seo';
import useScrollReveal from '../hooks/useScrollReveal';
import '../styles/scroll-reveal.css';
import './Home-User-Page.css';

// SPD2-4 (speed megaplan): the auction date now comes from the cached public
// API (/api/site-config/auction) instead of the client Firestore SDK. That one
// import was pulling the ~105KB-gzip Firebase chunk into the homepage — the
// largest asset on the public site. The endpoint is Redis- + edge-cached and
// the component below polls it every 5 minutes (the doc changes ~monthly).

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
  // Entity reconciliation for answer engines (GEO): same public facts as the
  // static Organization node in index.html — nothing invented.
  telephone: '+639620618672',
  email: 'magisgoldandgems.pawnshop@gmail.com',
  sameAs: [
    'https://www.facebook.com/magispawnshop/',
    'https://www.instagram.com/magisgoldandgems/',
  ],
  parentOrganization: { '@id': `${SITE_ORIGIN}/#organization` },
  // Match the real service footprint (keyword-map geo): branches cluster in
  // Angeles City / Pampanga / Central Luzon + Quezon City, nationwide brand.
  areaServed: [
    { '@type': 'City', name: 'Angeles City' },
    { '@type': 'AdministrativeArea', name: 'Pampanga' },
    { '@type': 'AdministrativeArea', name: 'Central Luzon' },
    { '@type': 'City', name: 'Quezon City' },
    { '@type': 'Country', name: 'Philippines' },
  ],
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
        <div className="countdown-label">Araw</div>
      </div>
      <div className="countdown-item">
        <div className="countdown-value">{timeLeft.hours}</div>
        <div className="countdown-label">Oras</div>
      </div>
      <div className="countdown-item">
        <div className="countdown-value">{timeLeft.minutes}</div>
        <div className="countdown-label">Minuto</div>
      </div>
      <div className="countdown-item">
        <div className="countdown-value">{timeLeft.seconds}</div>
        <div className="countdown-label">Segundo</div>
      </div>
    </div>
  );
}

function Home() {
  // Scroll-reveals for below-fold sections (shared hook; hydration/SEO safe).
  const revealRef = useScrollReveal();

  // Target date for the auction display + countdown. The per-second ticking is
  // isolated in <AuctionCountdown/> so the rest of the page stays static.
  const [nextAuctionDate, setNextAuctionDate] = useState(() => computeNextAuctionFallback());

  // Read the CMS-configured date from the cached public API (SPD2-4). The
  // parsing/fallback logic is identical to the old Firestore path; dates
  // arrive as ISO strings.
  useEffect(() => {
    const toDateSafe = (value) => {
      if (!value) return null;
      const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : value;
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

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${process.env.REACT_APP_API_URL || ''}/api/site-config/auction`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setNextAuctionDate(data && data.exists ? pickDateFromData(data) : computeNextAuctionFallback());
      } catch (err) {
        // Keep whatever we have (initial state is already the computed fallback).
        console.warn('[HOME] auction config fetch failed:', err?.message);
      }
    };

    load();
    const timer = setInterval(load, 5 * 60 * 1000); // matches the cache TTL
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="home-page flex flex-col min-h-screen" ref={revealRef}>
      <Seo
        title="Magis Pawnshop & Jewelry | Instant Cash for Your Gold"
        description="Sangla ng gold jewelry, subasta, at jewelry sales since 1996. Mataas ang appraisal, mababa ang interest, at mabilis ang proseso — instant cash for your gold."
        path="/"
        jsonLd={HOME_JSONLD}
      />

      {/* Hero */}
      <section className="home-hero">
        <div className="home-shell home-hero__inner">
          <h1 className="home-hero__title">Isangla ang gold jewelry mo — instant cash, patas na presyo.</h1>
          <p className="home-hero__sub">
            Safe, private, at patas na paraan para magka-cash kapag kailangan.
            Walang mahabang proseso, walang hassle — diretso at mabilis na
            serbisyo kapag kailangan mo talaga.
          </p>
          <Link to="/branches" className="home-cta">
            <FaMapMarkerAlt aria-hidden="true" /> Find a Branch Near You{' '}
            <FaArrowRight aria-hidden="true" />
          </Link>
          <div className="home-trustline">
            <span><FaCertificate className="mr-2" aria-hidden="true" /> Serbisyo simula 1996</span>
            <span><FaBalanceScale className="mr-2" aria-hidden="true" /> Patas na appraisal</span>
            <span><FaClock className="mr-2" aria-hidden="true" /> Cash in minutes</span>
          </div>
        </div>
      </section>

      <main className="flex-grow">
        {/* Process */}
        <section className="home-section">
          <div className="home-shell">
            <div className="home-section-head" data-reveal>
              <p className="home-eyebrow">Ganito kadali</p>
              <h2 className="home-h2">Paano mag-sangla sa Magis.</h2>
              <p className="home-lead">
                Mabilis, malinaw, at walang pressure — mula pagpasok hanggang paglabas.
              </p>
            </div>
            <div className="home-steps">
              <div className="home-step" data-reveal>
                <span className="home-step__num">STEP 1</span>
                <h3 className="home-step__title">Dalhin ang alahas mo</h3>
                <p className="home-step__text">Pumunta sa kahit anong branch dala ang gold jewelry mo.</p>
              </div>
              <div className="home-step" data-reveal style={{ "--d": "0.08s" }}>
                <span className="home-step__num">STEP 2</span>
                <h3 className="home-step__title">Patas na appraisal</h3>
                <p className="home-step__text">Titimbangin at susuriin namin ang ginto mo base sa karat at timbang, at sasabihin agad kung magkano ang pwede mong ma-loan.</p>
              </div>
              <div className="home-step" data-reveal style={{ "--d": "0.16s" }}>
                <span className="home-step__num">STEP 3</span>
                <h3 className="home-step__title">Malinaw na usapan</h3>
                <p className="home-step__text">Ipapaliwanag namin nang maayos ang terms at interest rate. Walang hidden charges.</p>
              </div>
              <div className="home-step" data-reveal>
                <span className="home-step__num">STEP 4</span>
                <h3 className="home-step__title">Ikaw ang bahala</h3>
                <p className="home-step__text">Ikaw ang magdedesisyon kung tutuloy — no pressure, walang obligasyon.</p>
              </div>
              <div className="home-step" data-reveal style={{ "--d": "0.08s" }}>
                <span className="home-step__num">STEP 5</span>
                <h3 className="home-step__title">Kunin ang cash mo</h3>
                <p className="home-step__text">Kapag pumayag ka, hawak mo na ang pera within minutes.</p>
              </div>
              <div className="home-step" data-reveal style={{ "--d": "0.16s" }}>
                <span className="home-step__num">STEP 6</span>
                <h3 className="home-step__title">Tubusin nang ligtas</h3>
                <p className="home-step__text">Bayaran ang loan within the agreed term para mabawi mo nang buo at ligtas ang alahas mo.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Trust / privacy / fairness */}
        <section className="home-section">
          <div className="home-shell">
            <div className="home-section-head" data-reveal>
              <p className="home-eyebrow">Privacy</p>
              <h2 className="home-h2">Ang privacy mo, priority namin.</h2>
              <p className="home-lead">
                Alam naming personal na bagay ang pagsasangla. Trained ang staff
                namin sa discreet at professional na serbisyo.
              </p>
            </div>
            <div className="home-feature-grid">
              <div className="home-feature" data-reveal>
                <span className="home-feature__icon"><FaUserShield aria-hidden="true" /></span>
                <h3 className="home-feature__title">Diskretong serbisyo</h3>
                <p className="home-feature__text">Private at may respeto ang bawat transaksyon — diskreto at walang husga.</p>
              </div>
              <div className="home-feature" data-reveal style={{ "--d": "0.08s" }}>
                <span className="home-feature__icon"><FaLock aria-hidden="true" /></span>
                <h3 className="home-feature__title">Ligtas ang alahas mo</h3>
                <p className="home-feature__text">Nakatago nang ligtas ang ginto mo hanggang sa araw na tubusin mo ito.</p>
              </div>
              <div className="home-feature" data-reveal style={{ "--d": "0.16s" }}>
                <span className="home-feature__icon"><FaBalanceScale aria-hidden="true" /></span>
                <h3 className="home-feature__title">Patas na rates</h3>
                <p className="home-feature__text">Mataas ang appraisal at malinaw ang interest rate — nagsisimula sa 1%.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Monthly subasta */}
        <section className="home-section">
          <div className="home-shell">
            <div className="home-section-head" data-reveal>
              <p className="home-eyebrow">Buwanang subasta</p>
              <h2 className="home-h2">Malinaw na patakaran sa mga hindi natubos.</h2>
              <p className="home-lead">
                Naiintindihan naming nagbabago ang sitwasyon. Gusto naming maging malinaw
                sa simula pa lang kung ano ang mangyayari kapag hindi nabayaran ang loan.
              </p>
            </div>
            <ul className="home-policy" data-reveal>
              <li>Kapag lumagpas ang loan term at hindi mo na-renew o natubos ang alahas, isasama ito sa nakatakdang buwanang subasta (auction).</li>
              <li>Standard at malinaw na proseso ito para mabawi ng pawnshop ang hindi nabayarang loan.</li>
              <li>Ipapaliwanag namin ang lahat ng deadline at patakaran bago ka pumirma — para walang surprises.</li>
            </ul>

            <div className="home-countdown-wrap" data-reveal>
              <p className="home-countdown-meta">
                Susunod na subasta
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
            <div className="home-album" data-reveal>
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
