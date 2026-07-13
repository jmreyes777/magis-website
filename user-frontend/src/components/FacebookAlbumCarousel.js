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
  const wrapRef = useRef(null);

  // SPD2-5 (speed megaplan): the carousel sits at the BOTTOM of the homepage;
  // don't spend network/main-thread on it during first paint. Start loading
  // when the container is within ~1 viewport of scroll (or immediately in
  // browsers without IntersectionObserver).
  const [shouldLoad, setShouldLoad] = useState(
    typeof IntersectionObserver === "undefined"
  );
  // Observe the LOADING PLACEHOLDER (it renders immediately; the real
  // container only mounts after loading clears — observing wrapRef alone
  // would deadlock the deferral).
  const deferRef = useRef(null);
  useEffect(() => {
    if (shouldLoad) return;
    const el = deferRef.current || wrapRef.current;
    if (!el) {
      setShouldLoad(true); // defensive: never strand the section unloaded
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldLoad(true);
          io.disconnect();
        }
      },
      { rootMargin: "100% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shouldLoad]);

  // measured container width -> fully responsive sizing (seeded from the
  // viewport so the very first paint is already correct on mobile)
  const [cw, setCw] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1024
  );

  const AUTO_DELAY = 4000;

  // clamp helper
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // Responsive layout metrics, recomputed from the live container width so the
  // pieces always fit their frame (and the viewport) on any device.
  const baseW     = cw || 1024;
  const isNarrow  = baseW < 560;
  const cardH     = Math.round(clamp(baseW * 0.5, 200, 384)); // slide height
  const GAP       = isNarrow ? 10 : 24;
  const maxCardW   = Math.round(baseW * (isNarrow ? 0.58 : 0.42)); // smaller on phones; leaves side peeks
  const stagePadY  = Math.round(cardH * 0.12);  // vertical room so shadows aren't clipped
  const frameScale = 0.84;                      // shrink each piece inside its slide -> framed, not zoomed
  const shadow     = `drop-shadow(0 ${Math.round(cardH * 0.04)}px ${Math.round(cardH * 0.05)}px rgba(0,0,0,0.22))`;

  // load photos (deferred until near-viewport — SPD2-5)
  useEffect(() => {
    if (!shouldLoad) return;
    mounted.current = true;

    const fetchJSON = async (url, opts = {}, timeoutMs = 7000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };

    (async () => {
      try {
        // Fetch BOTH in parallel:
        //  (a) the prebuilt transparent cutouts (static, same-origin, fast), and
        //  (b) the live latest album from the backend.
        // The LIVE album is the source of truth for WHICH items show and their
        // order, so a freshly posted album appears instantly. Transparent
        // cutouts are overlaid by photo id wherever the off-site job has made
        // them (-> floating); items not yet processed show the live photo
        // (gently blended) until the next job run catches up.
        const manifestP = fetchJSON(
          "/catalog-cutouts/manifest.json",
          { headers: { Accept: "application/json" }, cache: "no-cache" },
          5000
        ).catch(() => null);

        const liveP = (async () => {
          const url = albumId
            ? `${API_BASE}/api/facebook/album/${encodeURIComponent(albumId)}/photos`
            : `${API_BASE}/api/facebook/albums/latest/photos`;
          return fetchJSON(url, { headers: { Accept: "application/json" } }, 7000);
        })().catch((e) => {
          // eslint-disable-next-line no-console
          console.warn("[Carousel] live album unavailable; using cutouts only:", e?.message || e);
          return null;
        });

        const [mj, live] = await Promise.all([manifestP, liveP]);

        // cutout lookup by photo id
        const cutoutById = new Map();
        if (mj && Array.isArray(mj.items)) {
          for (const it of mj.items) cutoutById.set(String(it.id), it);
        }

        let list = [];
        const livePhotos = Array.isArray(live?.photos) ? live.photos : null;

        if (livePhotos && livePhotos.length) {
          // Live album drives membership + order; overlay cutouts by id.
          list = livePhotos.map((p) => {
            const id = String(p.id);
            const cut = cutoutById.get(id);
            return cut
              ? { id, caption: cut.caption || p.caption || "", cutout: true,
                  images: [{ src: cut.src, w: cut.w, h: cut.h }] }
              : { id, caption: p.caption || "", cutout: false,
                  images: Array.isArray(p.images) ? p.images : [] };
          });
        } else if (cutoutById.size) {
          // Live album unavailable -> show the cutouts we have (still floating).
          list = (mj.items || []).map((it) => ({
            id: String(it.id),
            caption: it.caption || "",
            cutout: true,
            images: [{ src: it.src, w: it.w, h: it.h }],
          }));
        }

        if (mounted.current) {
          setPhotos(list);
          setActive(0);
          if (!list.length && !live && !cutoutById.size) {
            setError("Unable to load catalog photos at the moment.");
          }
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
  }, [albumId, shouldLoad]);

  // Measure the carousel via a CALLBACK ref. The container renders only AFTER
  // the loading state clears, so a plain mount effect would see a null ref and
  // never attach (leaving cw at the desktop fallback -> oversized on phones).
  const roRef = useRef(null);
  const measureRef = useCallback((node) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    wrapRef.current = node;
    if (!node) return;
    const update = () => setCw(node.clientWidth || node.offsetWidth || 0);
    update();
    if (typeof ResizeObserver !== "undefined") {
      roRef.current = new ResizeObserver(update);
      roRef.current.observe(node);
    }
  }, []);

  // Fallback for orientation changes / browsers without ResizeObserver.
  useEffect(() => {
    const update = () => {
      const el = wrapRef.current;
      if (el) setCw(el.clientWidth || el.offsetWidth || 0);
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

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
      const w = Number(img?.w ?? img?.width)  || 1080;
      const h = Number(img?.h ?? img?.height) || 1080;
      const aspect = w / h;
      // Width follows the piece's aspect at the responsive height, but is capped
      // so the center piece always fits the viewport (with room for side peeks).
      const cardW = clamp(Math.round(cardH * aspect), 140, maxCardW);
      return { cardW, cardH };
    });
  }, [photos, cardH, maxCardW]);

  const len        = photos.length;
  const leftIndex  = len ? (active - 1 + len) % len : -1;
  const rightIndex = len ? (active + 1) % len : -1;

  const roles = len
    ? photos.map((_, i) =>
        i === active ? "center" : i === leftIndex ? "left" : i === rightIndex ? "right" : "off"
      )
    : [];

  if (loading) return <div ref={deferRef} className="text-gray-500 py-4 text-center">Loading catalog…</div>;
  if (error)   return <div className="text-red-500 py-4 text-center">{error}</div>;
  if (!len)    return <div className="text-gray-500 py-4 text-center">No catalog items found.</div>;

  // Place side pieces just outside the center piece using per-side widths so they
  // never overlap regardless of each photo's aspect ratio.
  const centerW = dims[active]?.cardW || 320;
  const leftW   = dims[leftIndex]?.cardW || centerW;
  const rightW  = dims[rightIndex]?.cardW || centerW;
  const leftShift  = Math.round(centerW / 2 + GAP + leftW / 2);
  const rightShift = Math.round(centerW / 2 + GAP + rightW / 2);

  const styleFor = (role) => {
    switch (role) {
      case "left":   return { transform: `translateX(-${leftShift}px) scale(0.9)`, opacity: isNarrow ? 0.85 : 1, zIndex: 1 };
      case "right":  return { transform: `translateX(${rightShift}px) scale(0.9)`, opacity: isNarrow ? 0.85 : 1, zIndex: 1 };
      case "center": return { transform: `translateX(0) scale(1)`,                 opacity: 1, zIndex: 2 };
      default:       return { transform: `translateX(0) scale(0.85)`,              opacity: 0, zIndex: 0, pointerEvents: "none" };
    }
  };

  return (
    <div
      ref={measureRef}
      className="relative max-w-6xl mx-auto px-4 select-none"
      onPointerDown={markInteracted}
      onMouseDown={markInteracted}
      onTouchStart={markInteracted}
      style={{ height: cardH + stagePadY * 2 + 44 }}
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

      {/* Stage — transparent cutouts float directly on the page; items not yet processed show a clean white product card */}
      <div
        className="relative w-full flex items-center justify-center overflow-hidden"
        style={{ height: cardH + stagePadY * 2 }}
      >
        {photos.map((p, i) => {
          const src = p?.images?.[0]?.src || "";
          const role = roles[i];
          const cardW = dims[i]?.cardW || maxCardW;

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
                willChange: "transform",
                ...styleFor(role),
              }}
              onClick={() => role !== "off" && setLightbox(p)}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  // Cutouts float directly on the page. Items the off-site job
                  // hasn't processed yet sit inside a clean white product card
                  // (intentional framing) instead of a broken multiply blend.
                  ...(p.cutout
                    ? {}
                    : {
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "#fff",
                        borderRadius: Math.max(10, Math.round(cardH * 0.045)),
                        border: "1px solid rgba(2,6,23,0.06)",
                        boxShadow: `0 ${Math.round(cardH * 0.03)}px ${Math.round(
                          cardH * 0.06
                        )}px rgba(2,6,23,0.18)`,
                        padding: Math.max(8, Math.round(cardH * 0.06)),
                        overflow: "hidden",
                      }),
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
                    transformOrigin: "center center",
                    // Cutouts get breathing room + a soft shape-shadow so they
                    // float; carded fallbacks are framed by the card's padding.
                    ...(p.cutout
                      ? { transform: `scale(${frameScale})`, filter: shadow }
                      : null),
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
