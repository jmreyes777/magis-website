// public/static/js/recaptcha-handler.js
// Executes and refreshes reCAPTCHA v3 tokens with exponential backoff.

;(function () {
  // Read the site key from the global injected in index.html
  const SITE_KEY = window.RECAPTCHA_KEY;
  const MAX_ATTEMPTS = 5;
  const INITIAL_DELAY = 1000; // 1s

  function executeRecaptcha(attempts = MAX_ATTEMPTS, delay = INITIAL_DELAY) {
    if (!window.grecaptcha) {
      console.warn(`[WARNING] grecaptcha not available, retrying in ${delay}ms...`);
      if (attempts > 0) {
        setTimeout(() => executeRecaptcha(attempts - 1, delay * 2), delay);
      }
      return;
    }
    console.info("[INFO] grecaptcha ready, executing...");
    window.grecaptcha.ready(() => {
      window.grecaptcha.execute(SITE_KEY, { action: "login" })
        .then(token => {
          console.info("[reCAPTCHA] Token:", token);
          sessionStorage.setItem("recaptchaToken", token);
        })
        .catch(err => {
          console.error("[ERROR] reCAPTCHA execution failed:", err);
          if (attempts > 0) {
            setTimeout(() => executeRecaptcha(attempts - 1, delay * 2), delay);
          }
        });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    executeRecaptcha();
    // Refresh every minute
    setInterval(() => {
      console.info("[INFO] Refreshing reCAPTCHA token...");
      if (window.grecaptcha) {
        window.grecaptcha.execute(SITE_KEY, { action: "refresh" })
          .then(token => {
            console.info("[reCAPTCHA] Refreshed Token:", token);
            sessionStorage.setItem("recaptchaToken", token);
          })
          .catch(err => {
            console.error("[ERROR] reCAPTCHA refresh failed:", err);
          });
      }
    }, 60_000);
  });
})();
