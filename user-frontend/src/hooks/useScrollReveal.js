// src/hooks/useScrollReveal.js
// Shared scroll-reveal hook (extracted from About-Us-User-Page). Attach the
// returned ref to a page root; elements inside carrying [data-reveal] rise
// into view as they enter the viewport. Elements support a per-element
// transition delay via the --d CSS custom property (inline style).
//
// HYDRATION/SEO SAFE BY CONSTRUCTION: the hidden state class is applied by
// JS AFTER mount, and only to elements still below the viewport — so the
// prerender snapshot, crawlers, no-JS visitors, reduced-motion users, and
// anything already on screen always see fully visible content.
//
// Pair with src/styles/scroll-reveal.css (default class) or a page-local
// equivalent (e.g. the About page passes "about-reveal").
import { useEffect, useRef } from "react";

export default function useScrollReveal(className = "scroll-reveal") {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;

    const targets = Array.from(root.querySelectorAll("[data-reveal]"));
    if (targets.length === 0) return undefined;

    // PERF: no synchronous getBoundingClientRect() sweep here — this effect
    // runs right after React's commit, when layout is dirty, so measuring N
    // elements forced a full-page reflow (~40ms on mobile CPUs; Lighthouse
    // "forced reflow"). Instead the observer's FIRST callback batch supplies
    // entry.boundingClientRect from the browser's own async layout pass, and
    // the below-viewport check happens there at zero layout cost. Elements
    // stay visible for the frame before that batch arrives, preserving the
    // hydration/SEO guarantee above (below-fold only, so nothing flashes).
    const measured = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          if (!measured.has(el)) {
            measured.add(el);
            const belowFold =
              entry.boundingClientRect.top > window.innerHeight * 0.92;
            if (!belowFold) {
              // Already on screen (or nearly) — never hide it.
              io.unobserve(el);
              return;
            }
            el.classList.add(className);
            if (!entry.isIntersecting) return;
            // Rare: below the 92% line yet already intersecting (tall
            // viewport overlap) — reveal on the next frame so the hide →
            // reveal transition still animates.
            requestAnimationFrame(() => el.classList.add("in"));
            io.unobserve(el);
            return;
          }
          if (!entry.isIntersecting) return;
          el.classList.add("in");
          io.unobserve(el);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.15 }
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [className]);

  return rootRef;
}
