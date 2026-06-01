// src/hooks/useWakeLock.js
import { useEffect, useRef } from "react";

// (Optional) import your NoSleep fallback if you still want it
import NoSleep from "nosleep.js";

export function useWakeLock(enabled = true) {
  const wakeLockRef = useRef(null);
  const noSleepRef  = useRef(null);

  const isSupported = typeof navigator !== "undefined" && "wakeLock" in navigator;

  // Try to acquire a Wake Lock (or fallback)
  const requestWakeLock = async () => {
    // 1️⃣ Only when enabled, supported, and page is visible
    if (!enabled || !isSupported || document.visibilityState !== "visible") {
      console.debug("[WAKE LOCK] ⚠️ Skipping request—page not visible or disabled");
      return;
    }

    try {
      // Standard API
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      console.log("[WAKE LOCK] ✅ Acquired screen lock");

      // Re-request if it ever releases unexpectedly
      wakeLockRef.current.addEventListener("release", () => {
        console.warn("[WAKE LOCK] ⚠️ Released — re-requesting");
        requestWakeLock();
      });
    } catch (err) {
      console.error("[WAKE LOCK] ❌ request() failed:", err);
      // Fallback to NoSleep if you still want it
      if (!noSleepRef.current) {
        noSleepRef.current = new NoSleep();
      }
      try {
        noSleepRef.current.enable();
        console.log("[NoSleep] ✅ Fallback enabled");
      } catch (noErr) {
        console.error("[NoSleep] ❌ Fallback enable failed:", noErr);
      }
    }
  };

  // Release any locks
  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        console.log("[WAKE LOCK] ⛔️ Released by code");
      } catch (_) {}
      wakeLockRef.current = null;
    }
    if (noSleepRef.current) {
      try {
        noSleepRef.current.disable();
        console.log("[NoSleep] ⛔️ Fallback disabled");
      } catch (_) {}
      noSleepRef.current = null;
    }
  };

  useEffect(() => {
    // 2️⃣ On mount, try to acquire if visible
    if (document.visibilityState === "visible") {
      requestWakeLock();
    }

    // 3️⃣ Whenever visibility changes, acquire/release
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      // 4️⃣ Clean up on unmount
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseWakeLock();
    };
  }, [enabled]);
}
