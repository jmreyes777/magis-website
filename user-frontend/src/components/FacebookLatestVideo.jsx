import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE =
  (process.env.REACT_APP_API_URL &&
    process.env.REACT_APP_API_URL.replace(/\/$/, "")) ||
  "";

// Optional: put this on the page from your server when you render HTML:
// <script nonce="{res.locals.nonce}">window.__CSP_NONCE="{res.locals.nonce}"</script>

export default function FacebookLatestVideo() {
  const [video, setVideo] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sdkReady, setSdkReady] = useState(!!window.FB);
  const [playerReady, setPlayerReady] = useState(false);
  const [painted, setPainted] = useState(false); // hide poster when FB paints

  const wrapperRef = useRef(null);
  const playerRef = useRef(null);   // FB player instance
  const nodeRef = useRef(null);     // fb-video div

  /* ---------------- Fetch Latest Video ---------------- */
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!API_BASE) throw new Error("Missing REACT_APP_API_URL");

        const res = await fetch(`${API_BASE}/api/facebook/latest-video`, {
          headers: { Accept: "application/json" },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error || data?.message || `HTTP ${res.status}`;
          throw new Error(msg);
        }
        if (mounted) setVideo(data?.video ?? null);
      } catch (e) {
        console.error("Facebook video fetch failed:", e);
        if (mounted) setErr("Unable to load video at the moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  /* ---------------- Load FB SDK once (with nonce if present) ---------------- */
  useEffect(() => {
    if (window.FB) {
      setSdkReady(true);
      return;
    }
    const s = document.createElement("script");
    s.async = true;
    s.defer = true;
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    if (window.__CSP_NONCE) s.setAttribute("nonce", window.__CSP_NONCE);

    s.onload = () => {
      // Init only once
      if (!window.FB?._initialized) {
        window.FB.init({
          xfbml: true,
          version: "v18.0",
        });
        window.FB._initialized = true;
      }
      setSdkReady(true);
    };
    document.head.appendChild(s);
    return () => {
      try { document.head.removeChild(s); } catch {}
    };
  }, []);

  /* ---------------- Compute aspect & href ---------------- */
  const { href, ratio } = useMemo(() => {
    if (!video) return { href: null, ratio: 9 / 16 };

    // Aspect ratio: try to read from embed_html if available; otherwise default
    const widthMatch = video.embed_html?.match(/width="(\d+)"/i);
    const heightMatch = video.embed_html?.match(/height="(\d+)"/i);
    const w = widthMatch ? parseFloat(widthMatch[1]) : 1080;
    const h = heightMatch ? parseFloat(heightMatch[1]) : 1920;
    const aspect = h > 0 && w > 0 ? h / w : 9 / 16;

    // Prefer official permalink (absolute URLs pass through, relative get fb.com prefix)
    let fbHref = null;
    if (video.permalink_url) {
      fbHref = /^https?:\/\//i.test(video.permalink_url)
        ? video.permalink_url
        : `https://www.facebook.com${video.permalink_url}`;
    }

    // Fallback: extract inner href from embed_html if needed
    if (!fbHref && video.embed_html) {
      const srcMatch = video.embed_html.match(/src="([^"]+)"/i);
      const baseSrc = srcMatch ? srcMatch[1] : null;
      if (baseSrc) {
        const u = new URL(baseSrc, window.location.origin);
        const inner = u.searchParams.get("href");
        if (inner) fbHref = inner;
      }
    }

    return { href: fbHref, ratio: aspect };
  }, [video]);

  const posterUrl = useMemo(() => {
    if (video?.thumbnail_url) return video.thumbnail_url;
    if (video?.id) return `https://graph.facebook.com/${video.id}/picture?type=large`;
    return null;
  }, [video]);

  /* ---------------- Render/Bind the FB player ---------------- */
  useEffect(() => {
    if (!sdkReady || !href || !nodeRef.current) return;

    // Clear previous render (if any)
    nodeRef.current.innerHTML = `
      <div class="fb-video"
           data-href="${href}"
           data-allowfullscreen="true"
           data-autoplay="false"
           data-show-text="false"
           data-width="auto"></div>
    `;

    // Parse the XFBML in this container only
    window.FB.XFBML.parse(nodeRef.current, () => {
      // Get player instance when ready
      window.FB.Event.subscribe("xfbml.ready", (msg) => {
        if (msg.type === "video" && msg.id && nodeRef.current?.contains(msg.element)) {
          playerRef.current = msg.instance; // FB.Player
          setPlayerReady(true);

          // Paint event tends to fire implicitly when metadata is ready. Use it to hide poster.
          playerRef.current.subscribe("startedBuffering", () => setPainted(true));
          playerRef.current.subscribe("startedPlaying", () => setPainted(true));
          playerRef.current.subscribe("paused", () => { /* keep painted state */ });
        }
      });
    });

    return () => {
      try {
        playerRef.current = null;
      } catch {}
    };
  }, [sdkReady, href]);

  /* ---------------- Click to Play (reliable on iOS/Android) ---------------- */
  const handleTap = () => {
    try {
      if (playerRef.current) {
        // One-tap: play with sound after user gesture
        playerRef.current.unmute?.();
        playerRef.current.setVolume?.(1.0);
        playerRef.current.play();
      }
    } catch (e) {
      // No-op
    }
  };

  /* ---------------- States ---------------- */
  if (loading)
    return <div className="text-center text-gray-500 py-8">Loading latest video…</div>;
  if (err)
    return <div className="text-center text-red-500 py-8">{err}</div>;
  if (!video || !href)
    return (
      <div className="text-center text-gray-500 py-8">
        No live selling video available right now.
      </div>
    );

  /* ---------------- UI ---------------- */
  return (
    <section className="max-w-5xl mx-auto px-4 text-center">
      <h2 className="text-2xl md:text-3xl font-bold mb-3 text-gray-900">
        Latest Live-Selling Session
      </h2>

      <div className="w-full mx-auto">
        <div
          ref={wrapperRef}
          className="relative w-full rounded-lg shadow-lg bg-black overflow-hidden"
          style={{
            // exact aspect from FB so it’s not zoomed
            paddingTop: `${Math.max(0.01, ratio) * 100}%`,
            // Avoid mobile scroll jumps
            overscrollBehavior: "contain",
            scrollMarginTop: "0px",
            WebkitTapHighlightColor: "transparent",
            touchAction: "manipulation",
          }}
        >
          {/* FB video gets rendered inside here */}
          <div
            ref={nodeRef}
            className="absolute inset-0 w-full h-full"
            // Prevent accidental text selection/long-press zoom
            style={{ userSelect: "none" }}
            onClick={handleTap}
            onTouchEnd={handleTap}
          />

          {/* Poster until FB paints */}
          {!painted && posterUrl && (
            <img
              src={posterUrl}
              alt="Video preview"
              className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
              draggable="false"
            />
          )}
        </div>
      </div>

      <p className="mt-3 text-sm text-gray-600">
        <a
          href={
            /^https?:\/\//i.test(video?.permalink_url)
              ? video.permalink_url
              : `https://www.facebook.com${video?.permalink_url || ""}`
          }
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          Watch on Facebook
        </a>{" "}
        • Uploaded{" "}
        {video.creation_time
          ? new Date(video.creation_time).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "Unknown date"}
      </p>
    </section>
  );
}
