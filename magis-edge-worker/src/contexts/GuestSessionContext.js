import React, { createContext, useState, useEffect, useContext, useRef } from "react";
import { initGuestSession } from "../utils/initGuestSession"; // ✅ Now returns singleton promise

export const GuestSessionContext = createContext();

export const useGuestSession = () => {
  return useContext(GuestSessionContext);
};

/**
 * Ensures sessionStorage contains guestId + guestToken before rendering app.
 * Uses a globally memoized initGuestSession() to prevent double guest creation.
 */
export const GuestSessionProvider = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [guestId, setGuestId] = useState(null);
  const [guestToken, setGuestToken] = useState(null);
  const initializedRef = useRef(false);  // This ref will prevent re-initialization

  useEffect(() => {
    // Ensure the guest session is only initialized once
    const initializeGuestSession = async () => {
      if (!initializedRef.current) {
        try {
          const sessionData = await initGuestSession();
          const { guestId, guestToken } = sessionData;
          
          // Set session data only once
          if (!guestId || !guestToken) {
            throw new Error("Invalid guest session data");
          }
          
          initializedRef.current = true;  // Mark as initialized
          setGuestId(guestId);
          setGuestToken(guestToken);
          setReady(true);
        } catch (err) {
          console.error("[GUEST] ❌ Failed to initialize guest session:", err.message);
        }
      }
    };

    initializeGuestSession();
  }, []); // Only run once when component mounts

  if (!ready) {
    return (
      <div className="text-center mt-10">
        Initializing guest session... Please wait.
      </div>
    );
  }

  return (
    <GuestSessionContext.Provider value={{ ready, guestId, guestToken }}>
      {children}
    </GuestSessionContext.Provider>
  );
};
