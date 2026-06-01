import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { FaChevronLeft, FaChevronRight, FaTimes } from "react-icons/fa";

const API_BASE =
  (process.env.REACT_APP_API_URL &&
    process.env.REACT_APP_API_URL.replace(/\/$/, "")) ||
  "";

/**
 * Hardened center-mode carousel
 * - Shows FULL image (no cropping) via <img> with a local style reset (all: initial)
 * - Per-image adaptive width from aspect ratio (so portraits don’t look skinny)
 * - Smooth translate/scale/opacity transitions
 * - Auto-plays by default; pauses after any user interaction
 * - Immunized against global CSS leaks (isolation + inline locks)
 */
export default function FacebookAlbumCarousel({ albumId }) {
  const [photos, setPhotos] = useState([]);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0);
  const [lightbox, setLightbox] = useState(null);

  const autoTimer = useRef(null);
  const userInteracted = useRef(false);
  const mounted = useRef(false);

  // visual constants
  const CARD_H = 384;      // fixed slide height
  const GAP    = 24;       // spacing between logical positions
  const AUTO_DELAY = 4000;

  // clamp helper
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // load photos
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        if (!API_BASE) throw new Error("Missing REACT_APP_API_URL");
        const url = albumId
          ? `${API_BASE}/api/facebook/album/${encodeURIComponent(albumId)}/photos`
          : `${API_BASE}/api/facebook/albums/latest/photos`;
        const res  = await fetch(url, { headers: { Accept: "application/json" } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);

        if (mounted.current) {
          const list = Array.isArray(data?.photos) ? data.photos : [];
          setPhotos(list);
          setActive(0);
        }
      } catch (e) {
        if (mounted.current) setError("Unable to load catalog photos at the moment.");
        // eslint-disable-next-line no-console
        console.error("[Carousel] fetch failed:", e);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
      clearInterval(autoTimer.current);
    };
  }, [albumId]);

  // autoplay (pauses on any interaction)
  useEffect(() => {
    if (!photos.length) return;
    clearInterval(autoTimer.current);
    autoTimer.current = setInterval(() => {
      if (userInteracted.current) return;
      setActive((i) => (i + 1) % photos.length);
    }, AUTO_DELAY);
    return () => clearInterval(autoTimer.current);
  }, [photos.length]);

  const markInteracted = useCallback(() => {
    if (!userInteracted.current) {
      userInteracted.current = true;
      clearInterval(autoTimer.current);
    }
  }, []);

  const next = useCallback(() => { markInteracted(); setActive(i => (i + 1) % photos.length); }, [photos.length, markInteracted]);
  const prev = useCallback(() => { markInteracted(); setActive(i => (i - 1 + photos.length) % photos.length); }, [photos.length, markInteracted]);

  // per-image dimensions derived from aspect ratio (defended with sensible defaults)
  const dims = useMemo(() => {
    return photos.map((p) => {
      const img = Array.isArray(p.images) && p.images[0] ? p.images[0] : null;
      const w = Number(img?.width)  || 1080;
      const h = Number(img?.height) || 1080;
      const aspect = w / h;
      // preserve full image while avoiding “skinny” look:
      const cardW = clamp(Math.round(CARD_H * aspect), 320, 560); // min 320px, max 560px
      return { cardW, cardH: CARD_H };
    });
  }, [photos]);

  const len        = photos.length;
  const leftIndex  = len ? (active - 1 + len) % len : -1;
  const rightIndex = len ? (active + 1) % len : -1;

  const roles = len
    ? photos.map((_, i) =>
        i === active ? "center" : i === leftIndex ? "left" : i === rightIndex ? "right" : "off"
      )
    : [];

  if (loading) return <div className="text-gray-500 py-4 text-center">Loading catalog…</div>;
  if (error)   return <div className="text-red-500 py-4 text-center">{error}</div>;
  if (!len)    return <div className="text-gray-500 py-4 text-center">No catalog items found.</div>;

  // SHIFT based on the actual center card’s width
  const centerW = dims[active]?.cardW || 400;
  const SHIFT   = centerW + GAP;

  const styleFor = (role) => {
    switch (role) {
      case "left":   return { transform: `translateX(-${SHIFT}px) scale(0.95)`, opacity: 0.9, zIndex: 1 };
      case "right":  return { transform: `translateX(${SHIFT}px) scale(0.95)`,  opacity: 0.9, zIndex: 1 };
      case "center": return { transform: `translateX(0) scale(1.06)`,           opacity: 1,   zIndex: 2 };
      default:       return { transform: `translateX(0) scale(0.85)`,           opacity: 0,   zIndex: 0, pointerEvents: "none" };
    }
  };

  return (
    <div
      className="relative max-w-6xl mx-auto px-4 select-none"
      onPointerDown={markInteracted}
      onMouseDown={markInteracted}
      onTouchStart={markInteracted}
      style={{ height: CARD_H + 72 }}
    >
      {/* Controls */}
      <button
        onClick={prev}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-30 bg-white/90 text-gray-800 rounded-full p-2 shadow hover:bg-yellow-500 hover:text-white transition"
        aria-label="Previous"
      >
        <FaChevronLeft size={20} />
      </button>
      <button
        onClick={next}
        className="absolute right-0 top-1/2 -translate-y-1/2 z-30 bg-white/90 text-gray-800 rounded-full p-2 shadow hover:bg-yellow-500 hover:text-white transition"
        aria-label="Next"
      >
        <FaChevronRight size={20} />
      </button>

      {/* Stage (style isolation so globals can’t leak) */}
      <div
        className="relative h-full w-full flex items-center justify-center overflow-hidden py-6"
        style={{ isolation: "isolate" }}
      >
        {photos.map((p, i) => {
          const src = p?.images?.[0]?.src || "";
          const role = roles[i];
          const { cardW, cardH } = dims[i] || { cardW: 400, cardH: CARD_H };

          return (
            <div
              key={p.id || i}
              className="absolute"
              style={{
                width: cardW,           // hard width lock (prevents “skinny”)
                minWidth: cardW,
                maxWidth: cardW,
                height: cardH,
                transition: "transform 600ms cubic-bezier(0.22,1,0.36,1), opacity 600ms ease",
                willChange: "transform, opacity",
                ...styleFor(role),
              }}
              onClick={() => role !== "off" && setLightbox(p)}
            >
              <div
                className="rounded-lg shadow-sm"
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundColor: "white",
                  overflow: "hidden",
                }}
              >
                {/* The actual pixels — locally reset so global CSS can’t touch it */}
                <img
                  src={src}
                  alt={p.caption || "Catalog item"}
                  loading="lazy"
                  style={{
                    all: "initial",                // 🔒 reset EVERYTHING
                    display: "block",
                    width: "100%",                 // fill the card box
                    height: "100%",
                    objectFit: "contain",          // show FULL image; no crop
                    imageRendering: "auto",
                    backgroundColor: "white",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Dots */}
      <div className="flex justify-center mt-3 space-x-2">
        {photos.slice(0, Math.min(8, len)).map((_, i) => (
          <button
            key={i}
            onClick={() => { userInteracted.current = true; setActive(i); }}
            className={`w-2.5 h-2.5 rounded-full transition-colors ${i === active ? "bg-yellow-500" : "bg-gray-300"}`}
            aria-label={`Go to slide ${i + 1}`}
          />
        ))}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setLightbox(null)}>
          <div className="relative bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-3 right-3 bg-white text-gray-800 rounded-full p-2 shadow hover:bg-yellow-500 hover:text-white transition" onClick={() => setLightbox(null)} aria-label="Close lightbox">
              <FaTimes size={18} />
            </button>
            <div className="flex-1 flex items-center justify-center bg-white">
              <img
                src={lightbox.images?.[0]?.src || ""}
                alt={lightbox.caption || "Catalog item"}
                style={{
                  all: "initial", display: "block",
                  maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", backgroundColor: "white"
                }}
              />
            </div>
            {lightbox.caption && (
              <p className="p-3 text-center text-gray-700 text-sm border-t">{lightbox.caption}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
