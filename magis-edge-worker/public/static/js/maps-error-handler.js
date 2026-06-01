// public/static/js/maps-error-handler.js
// Polls for the Google Maps API to load, logs an error after timeout.

(function () {
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
  