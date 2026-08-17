// public/static/js/maps-error-handler.js
// Polls for the Google Maps API to load, logs an error after timeout.

(function () {
    // Only the branch finder loads Google Maps. Everywhere else this monitor
    // used to poll for 10s and then console.error on EVERY page — which
    // Lighthouse Best Practices flags as "browser errors were logged to the
    // console" on map-less routes like /jewelry-sales.
    if (!/^\/branches(\/|$)/.test(window.location.pathname)) return;

    const CHECK_INTERVAL = 100;   // ms
    const TIMEOUT        = 10000; // ms
  
    const start = Date.now();
    const intervalId = setInterval(() => {
      if (typeof google !== "undefined" && google.maps) {
        clearInterval(intervalId);
        console.info("[INFO] Google Maps API loaded successfully.");
      } else if (Date.now() - start > TIMEOUT) {
        clearInterval(intervalId);
        console.error(
          "❌ Failed to load Google Maps API within 10s. " +
          "Please check your network or API key."
        );
      }
    }, CHECK_INTERVAL);
  })();
  