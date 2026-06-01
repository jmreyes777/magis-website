export const ensureSessionHydrated = () => {
  return new Promise((resolve) => {
    const maxAttempts = 30;
    let attempts = 0;

    const check = () => {
      let token = sessionStorage.getItem("branchAdminToken");
      let email = sessionStorage.getItem("branchEmail");
      let id = sessionStorage.getItem("branchId");
      let name = sessionStorage.getItem("branchName");

      // ✅ Fully hydrated from sessionStorage
      if (token && email && id && name) {
        console.log("[SESSION] ✅ Full session hydrated");
        resolve({ token, email, id, name, hydrated: true });
        return;
      }

      // 🧠 Retry loop
      if (++attempts < maxAttempts) {
        setTimeout(check, 100);
      } else {
        // 🧩 Use in-memory fallback (e.g., set by AuthContext)
        const fallbackToken = token || window.__LAST_HYDRATED_TOKEN__;
        const fallbackEmail = email || window.__LAST_HYDRATED_EMAIL__;

        if (fallbackToken && fallbackEmail) {
          console.warn("[SESSION] ⚠️ Using in-memory fallback hydration", {
            fallbackToken,
            fallbackEmail,
          });

          // ✅ Patch: write to sessionStorage so downstream reads work
          if (!sessionStorage.getItem("branchAdminToken")) {
            sessionStorage.setItem("branchAdminToken", fallbackToken);
            sessionStorage.setItem("branchEmail", fallbackEmail);
            sessionStorage.setItem("branchAdminRole", "branchadmin");

            if (!sessionStorage.getItem("branchId")) {
              sessionStorage.setItem("branchId", id || "unknown");
            }
            if (!sessionStorage.getItem("branchName")) {
              sessionStorage.setItem("branchName", name || "unknown");
            }

            console.info("[SESSION] 💾 Patched sessionStorage with fallback values.");
          }

          resolve({
            token: fallbackToken,
            email: fallbackEmail,
            id: id || "unknown",
            name: name || "unknown",
            hydrated: true,
          });
        } else {
          console.error("[SESSION] ❌ Failed to hydrate session after retries", {
            token,
            email,
            id,
            name,
          });
          resolve({
            token: null,
            email: null,
            id: null,
            name: null,
            hydrated: false,
          });
        }
      }
    };

    check();
  });
};
