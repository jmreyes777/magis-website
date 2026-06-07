import "../utils/patchPassiveTouchListeners";  // must come before any React import
import Footer from '../components/Footer-User-Component';
import React, { useState, useEffect, useRef,useMemo } from "react";
import { useLocation } from "react-router-dom";
import { collection, getDocs } from "firebase/firestore";
import GuestChatBox from "../components/Guest-Chat-Box-Component";

import { db } from "../firebase-config";
import { 
  initializeMap, 
  updateMarkers, 
  fitMapToBounds,
  MAX_ZOOM_LEVEL
} from "../utils/mapUtils";
import { FaMapMarkerAlt, FaPhoneAlt, FaClock } from "react-icons/fa";
import "./BranchesMapView.css";
import { getSocketInstance, connectSocket, disconnectSocket } from "../Shared/User-Utils-socket";
import { getTurnstileToken } from "../Shared/turnstile";
const socket = getSocketInstance();

// Utility function for formatting schedules
const formatSchedule = (schedule) => {
  if (!schedule || schedule.length === 0) return "No schedule available";

  const formatted = [];
  let startDay = null;
  let currentTime = null;

  schedule.forEach((day, index) => {
    if (day.open) {
      const timeRange = `${day.openTime} to ${day.closeTime}`;
      if (!currentTime || currentTime !== timeRange) {
        if (currentTime) {
          formatted.push(`${startDay} - ${schedule[index - 1].day}: ${currentTime}`);
        }
        startDay = day.day;
        currentTime = timeRange;
      }
    } else if (currentTime) {
      formatted.push(`${startDay} - ${schedule[index - 1].day}: ${currentTime}`);
      currentTime = null;
    }
    if (index === schedule.length - 1 && currentTime) {
      formatted.push(`${startDay} - ${day.day}: ${currentTime}`);
    }
  });

  return formatted.join(", ");
};

// Utility function for highlighting text
const highlightMatch = (text, query) => {
  if (!query) return text;

  const parts = text.split(new RegExp(`(${query})`, "gi"));
  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <span key={index} className="bg-yellow-300">{part}</span>
    ) : (
      part
    )
  );
};

function BranchesMapView() {
  // Read initial filter from URL
  const location = useLocation();
  useEffect(() => {
    console.log("[DEBUG] location.search =", location.search);
  }, [location.search]);

  const params = new URLSearchParams(location.search);
  const initialFilter = params.get('filter') === 'jewelry' ? 'jewelry' : 'all';

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const f = p.get("filter") === "jewelry" ? "jewelry" : "all";
    setFilter(f);
  }, [location.search]);

  console.log("[DEBUG] initialFilter =", initialFilter);

  // State
  const [branches, setBranches] = useState([]);
  const memoizedBranches = useMemo(() => branches, [branches]);

  const [filteredBranches, setFilteredBranches] = useState([]);
  const memoizedFilteredBranches = useMemo(() => filteredBranches, [filteredBranches]);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeChat, setActiveChat] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeBranchId, setActiveBranchId] = useState(null);

  const mapRef = useRef(null);
  const branchRefs = useRef({});
  const branchListRef = useRef(null);

  const [mapReady, setMapReady] = useState(false);
  const [filter, setFilter] = useState(initialFilter);

  // Start map init immediately on mount — map is above the fold
  useEffect(() => { setMapReady(true); }, []);

  // 2️⃣ Fetch branches and init map
  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;

    const fetchAndInit = async () => {
      console.log("[DEBUG] Fetching branches…");
      try {
        const snap = await getDocs(collection(db, "branches"));
        const data = snap.docs.map(doc => ({
          id: doc.id,
          hasJewelryDisplay: doc.data().hasJewelryDisplay ?? false,
          ...doc.data(),
        }));
        if (cancelled) return;

        setBranches(data);
        console.log("[DEBUG] fetched branches count =", data.length);

        const initList = initialFilter === "jewelry"
          ? data.filter(b => b.hasJewelryDisplay)
          : data;
        console.log("[DEBUG] initList count after filter =", initList.length);
        setFilteredBranches(initList);

        await initializeMap(initList, mapRef, branchData => {
          if (cancelled) return;
          updateMarkers(
            branchData,
            mapRef,
            setActiveBranchId,
            handleBranchClickFromList
          );
        });
        if (cancelled) return;
        fitMapToBounds(initList, mapRef);
      } catch (err) {
        if (!cancelled) {
          console.error("[ERROR] Failed to load branches:", err);
          setError(err);
        }
      }
    };

    fetchAndInit();

    return () => {
      cancelled = true;
    };
  }, [mapReady, initialFilter]);

  // 2️⃣ Debounced search + filter
  const searchTimeoutRef = useRef(null);
  const handleSearchAndFilter = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      const q = searchQuery.toLowerCase().trim();
      const filtered = memoizedBranches.filter(branch => {
        const matchesQuery =
          branch.name.toLowerCase().includes(q) ||
          branch.actualAddress?.toLowerCase().includes(q) ||
          branch.address?.toLowerCase().includes(q);
        const matchesFilter =
          filter === "all" ||
          (filter === "jewelry" && branch.hasJewelryDisplay);
        return matchesQuery && matchesFilter;
      });

      console.log("[DEBUG] handleSearchAndFilter:", { filter, q, matches: filtered.length });

      if (JSON.stringify(filtered) !== JSON.stringify(memoizedFilteredBranches)) {
        setFilteredBranches(filtered);
        updateMarkers(
          filtered,
          mapRef,
          setActiveBranchId,
          handleBranchClickFromList
        );
        fitMapToBounds(filtered, mapRef);
      }
    }, 500);
  };

  useEffect(() => {
    handleSearchAndFilter();
  }, [searchQuery, filter, memoizedBranches]);

  // 3️⃣ Focus marker on list click
  const handleBranchClickFromList = branch => {
    setActiveBranchId(branch.id);
    branchRefs.current[branch.id]?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (mapRef.current?.map && branch.location) {
      mapRef.current.map.setCenter(branch.location);
      mapRef.current.map.setZoom(MAX_ZOOM_LEVEL);
    }
  };

  // ✅ Handle filter change
  const handleFilterChange = (e) => {
    setFilter(e.target.value);
    setActiveBranchId(null);
  };

  // 🔒 Helper to force-close a currently active chat on a different branch
  const forceCloseActiveIfAny = async () => {
    const currentGuestId = sessionStorage.getItem("guestId");
    const currentBranchEmail = sessionStorage.getItem("branchEmail");
    const token =
      sessionStorage.getItem("guestToken") ||
      localStorage.getItem("guestToken") ||
      window.__FALLBACK_GUEST_TOKEN__;

    if (!currentGuestId || !currentBranchEmail) return;

    try {
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/api/guest/force-close`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ guestId: currentGuestId, branchEmail: currentBranchEmail }),
        }
      );
      await res.json().catch(() => ({}));
    } catch (e) {
      console.warn("[BRANCHES] force-close fallback failed:", e.message);
    }

    // Disconnect socket & mark closed
    disconnectSocket(false, "manual");
    sessionStorage.removeItem("chatOpen");

    // Clear per-branch cache for safety
    const branchId = sessionStorage.getItem("branchId");
    if (branchId) {
      const cacheKey = `chatMessages-${currentGuestId}-${branchId}`;
      sessionStorage.removeItem(cacheKey);
    }
  };

  // 🚪 Open chat with prompt if another branch is active
  const openChatBox = async (branch) => {
    try {
      // If there’s an active chat for another branch, prompt first
      const activeFlag  = sessionStorage.getItem("chatOpen") === "true";
      const activeEmail = sessionStorage.getItem("branchEmail");
      // Check if there’s an active chat with a different branch
      if (activeFlag && activeEmail && activeEmail.toLowerCase() !== branch.email.toLowerCase()) {
        // Check if the active chat actually has messages in cache
        const activeGuestId = sessionStorage.getItem("guestId");
        const activeBranchId = sessionStorage.getItem("branchId");
        const activeCacheKey = `chatMessages-${activeGuestId}-${activeBranchId}`;
        const cachedMessages = sessionStorage.getItem(activeCacheKey);
        const hasMessages = cachedMessages && JSON.parse(cachedMessages).length > 0;

        if (hasMessages) {
          // ✅ Prompt only if there’s real conversation content
          const ok = window.confirm(
            `You already have an active conversation with ${activeEmail}.\n` +
            `Close it and start a new chat with ${branch.email}?`
          );
          if (!ok) return;
        } else {
          console.log("[CHAT SWITCH] Skipping prompt — active chat is empty.");
        }

        // Always close the current chat before opening the new one
        await forceCloseActiveIfAny();
      }

      // 1) Restore guest session if possible
      let guestId    = sessionStorage.getItem("guestId");
      let guestToken = sessionStorage.getItem("guestToken");

      if (!guestId && localStorage.getItem("guestId")) {
        guestId = localStorage.getItem("guestId");
        sessionStorage.setItem("guestId", guestId);
      }
      if (!guestToken && localStorage.getItem("guestToken")) {
        guestToken = localStorage.getItem("guestToken");
        sessionStorage.setItem("guestToken", guestToken);
      }

      // 2a) If cookie exists but storage empty → refresh
      const cookieMatch = document.cookie.match(/(?:^|; )guestToken=([^;]+)/);
      const cookieToken = cookieMatch?.[1];
      if (!guestId && !guestToken && cookieToken) {
        console.log("[GUEST] 🍪 Found cookie, refreshing guest token");
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guestId, branchEmail: branch.email }),
          }
        );
        if (!res.ok) throw new Error("Guest refresh failed");
        const data = await res.json();
        guestToken = data.token;

      // 2b) No session at all → init
      } else if (!guestId && !guestToken) {
        console.log("[GUEST] 🆕 No session found, INIT new guest");
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/guest/init`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Anonymous Guest",
              email: `${Date.now()}@guest.local`,
              branchEmail: branch.email,
              turnstileToken: await getTurnstileToken(), // P1-4: bot check
            }),
          }
        );
        if (!res.ok) throw new Error("Guest init failed");
        const data = await res.json();
        guestId    = data.guestId;
        guestToken = data.token;

      // 3) Have ID but no token → refresh
      } else if (guestId && !guestToken) {
        console.log("[GUEST] 🔄 Guest ID exists but token missing, REFRESH");
        const res = await fetch(
          `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guestId, branchEmail: branch.email }),
          }
        );
        if (!res.ok) throw new Error("Token refresh failed");
        const data = await res.json();
        guestToken = data.token;
      }

      // 4) Persist
      sessionStorage.setItem("guestId",    guestId);
      sessionStorage.setItem("guestToken", guestToken);
      localStorage.setItem("guestId",      guestId);
      localStorage.setItem("guestToken",   guestToken);

      // Associate this branch in session (used by chat box + caches)
      sessionStorage.setItem("branchEmail", branch.email);
      sessionStorage.setItem("branchId", branch.id);

      console.log(`[SOCKET] Opening chatbox for guestId: ${guestId}`);

      // 5) Socket + UI
      if (!localStorage.getItem("tabId")) localStorage.setItem("tabId", crypto.randomUUID());
      if (!window.name) window.name = crypto.randomUUID();

      if (!socket.connected) {
        console.log("[SOCKET] Connecting socket with guest token…");
        connectSocket(guestId);
      }

      sessionStorage.setItem("chatOpen", "true");
      setActiveChat({
        branchId:    branch.id,
        branchEmail: branch.email,
        branchName:  branch.name,
        schedule:    branch.schedule || [],
        guestId,
      });

    } catch (err) {
      console.error("[SOCKET] ❌ Failed to open guest chat:", err);
      alert("Could not open chat. Please try again later.");
    }
  };

  // ✅ Cleanly close chatbox — socket disconnect is handled by GuestChatBox itself
  const closeChatBox = () => {
    sessionStorage.removeItem("chatOpen");
    setActiveChat(null);
  };

  return (
    <div className="flex flex-col min-h-screen ">
      <div className="w-full max-w-5xl mx-auto h-[700px] bg-white rounded-lg shadow-md border flex flex-col items-stretch">
        {/* 🌍 Google Map */}
        <div
          id="map"
          className={`map-container w-full ${filteredBranches.length === 0 ? 'reduced-height' : ''}`}
        >
          {!mapReady && (
            <img
              src={`https://maps.googleapis.com/maps/api/staticmap?center=14.5995,120.9842&zoom=9&size=800x600&scale=2&maptype=roadmap&key=${process.env.REACT_APP_GOOGLE_MAPS_API_KEY}`}
              alt="Map of Magis branch locations"
              width="800"
              height="600"
              fetchpriority="high"
              decoding="async"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          )}
        </div>

        {/* 🔍 Search & Filters */}
        <div className="search-filter-container w-full">
          <div className="search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search branches..."
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="clear-btn" onClick={() => setSearchQuery("")}>
                ✖
              </button>
            )}
          </div>

          <select
            value={filter}
            onChange={handleFilterChange}
            className="filter-select"
          >
            <option value="all">All Branches</option>
            <option value="jewelry">w/ Jewelry Display</option>
          </select>
        </div>

        {/* 📌 Branch List */}
        <div className="branch-list w-full" ref={branchListRef}>
          {isLoading ? (
            <p className="no-results">Loading branches...</p>
          ) : filteredBranches.length === 0 ? (
            <p className="no-results">
              {filter === "jewelry"
                ? "No sales branches with jewelry display found."
                : "Loading branches..."}
            </p>
          ) : (
            filteredBranches.map((branch) => {
              const isActive = branch.id === activeBranchId;
              return (
                <div
                  key={branch.id}
                  ref={(el) => (branchRefs.current[branch.id] = el)}
                  className={`branch-item ${isActive ? "active" : ""}`}
                  onClick={() => handleBranchClickFromList(branch)}
                  aria-current={isActive ? "true" : undefined}
                >
                  <h3 className="branch-name">
                    {highlightMatch(branch.name, searchQuery)}
                  </h3>
                  <div className="branch-info">
                    <FaMapMarkerAlt className="branch-icon" />
                    <span>
                      {highlightMatch(
                        branch.actualAddress || branch.address || "N/A",
                        searchQuery
                      )}
                    </span>
                  </div>
                  <div className="branch-info">
                    <FaPhoneAlt className="branch-icon" />
                    <span>{branch.phone || "N/A"}</span>
                  </div>
                  <div className="branch-info">
                    <FaClock className="branch-icon" />
                    <span>
                      {branch.schedule
                        ? highlightMatch(formatSchedule(branch.schedule), searchQuery)
                        : "No schedule available"}
                    </span>
                  </div>

                  {/* 💬 Chat Button */}
                  <button
                    className="chat-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      openChatBox(branch);
                    }}
                  >
                    Chat with {branch.name}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 💬 Chat Overlay */}
      {activeChat && (
        <GuestChatBox
          key={`${activeChat.branchId}-${activeChat.guestId}`}
          branchId={activeChat.branchId}
          branchEmail={activeChat.branchEmail}
          branchName={activeChat.branchName}
          schedule={activeChat.schedule || []}
          guestId={activeChat.guestId}
          onClose={closeChatBox}
        />
      )}
      <Footer />
    </div>
  );
}

export default BranchesMapView;