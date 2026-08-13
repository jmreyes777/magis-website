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
    const pending = targets.filter(
      (el) => el.getBoundingClientRect().top > window.innerHeight * 0.92
    );
    if (pending.length === 0) return undefined;

    pending.forEach((el) => el.classList.add(className));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.15 }
    );
    pending.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [className]);

  return rootRef;
}
