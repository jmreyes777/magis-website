// utils/waitForSessionReady.js
export const waitForSessionReady = async (maxAttempts = 30) => {
    for (let i = 0; i < maxAttempts; i++) {
      const token = sessionStorage.getItem("branchAdminToken");
      const email = sessionStorage.getItem("branchEmail");
  
      if (token && email) return { token, email };
  
      await new Promise((res) => setTimeout(res, 150));
    }
    return { token: null, email: null };
  };