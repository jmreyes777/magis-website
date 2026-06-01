// src/Shared/ScrollToTop-Component.jsx
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export default function ScrollToTop() {
  const location = useLocation();
  const cancelRef = useRef({});

  useEffect(() => {
    // cancel previous observers/timeouts if any
    if (cancelRef.current.cleanup) cancelRef.current.cleanup();

    const cleanupTasks = [];
    const cleanup = () => cleanupTasks.forEach(fn => fn && fn());

    // Helper: scroll to a dom node with sticky-header offset
    const scrollToEl = (el) => {
      const root = getComputedStyle(document.documentElement);
      const header = parseInt(root.getPropertyValue('--header-h')) || 64;
      // measure subnav if present (sticky second bar)
      const subnavH = document.querySelector('.subnav')?.getBoundingClientRect().height || 0;
      const offset = header + subnavH + 8;
      const y = Math.max(0, el.getBoundingClientRect().top + window.pageYOffset - offset);
      window.scrollTo({ top: y, left: 0, behavior: 'smooth' });
    };

    // If there is a hash, wait until the element is actually in the DOM
    if (location.hash) {
      const id = decodeURIComponent(location.hash.slice(1));

      // 1) Try immediately
      const nowEl = document.getElementById(id);
      if (nowEl) {
        // microtask to let layout settle
        const t = setTimeout(() => scrollToEl(nowEl), 0);
        cleanupTasks.push(() => clearTimeout(t));
        cancelRef.current.cleanup = cleanup;
        return cleanup;
      }

      // 2) Observe DOM for up to 3 seconds
      const observer = new MutationObserver(() => {
        const el = document.getElementById(id);
        if (el) {
          observer.disconnect();
          scrollToEl(el);
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      cleanupTasks.push(() => observer.disconnect());

      // 3) Safety timeout: also try every 150ms for ~3s
      let tries = 0;
      const interval = setInterval(() => {
        tries += 1;
        const el = document.getElementById(id);
        if (el) {
          clearInterval(interval);
          observer.disconnect();
          scrollToEl(el);
        } else if (tries > 20) {
          // give up after ~3s
          clearInterval(interval);
          observer.disconnect();
        }
      }, 150);
      cleanupTasks.push(() => clearInterval(interval));

      cancelRef.current.cleanup = cleanup;
      return cleanup;
    }

    // No hash: normal behavior (top)
    window.scrollTo(0, 0);
    cancelRef.current.cleanup = cleanup;
    return cleanup;
  }, [location.pathname, location.hash]);

  return null;
}
