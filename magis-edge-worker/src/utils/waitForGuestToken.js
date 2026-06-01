// utils/waitForGuestToken.js

export const waitForGuestToken = (maxRetries = 20, interval = 100) => {
    return new Promise((resolve, reject) => {
      let attempts = 0;
  
      const check = () => {
        const sessionToken = sessionStorage.getItem("guestToken");
        const localToken = localStorage.getItem("guestToken");
        const token = sessionToken || localToken;
  
        // Basic JWT structure check: 3 segments separated by "."
        if (token && token.split(".").length === 3) {
          if (!sessionToken && localToken) {
            // ⛑ Rehydrate sessionStorage if it's missing
            sessionStorage.setItem("guestToken", localToken);
            sessionStorage.setItem("guestId", localStorage.getItem("guestId"));
            console.log("[GUEST] ♻️ Rehydrated sessionStorage from localStorage during wait");
          }
          console.log("[GUEST] 🛡️ Guest token resolved after", attempts + 1, "attempts");
          return resolve(token);
        }
  
        if (++attempts >= maxRetries) {
          console.error("[GUEST] ❌ Guest token not found after max retries");
          return reject(new Error("Guest token not found"));
        }
  
        setTimeout(check, interval);
      };
  
      check();
    });
  };
  