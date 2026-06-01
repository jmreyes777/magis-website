import "../utils/patchPassiveTouchListeners";  // must come before any React import
import React, { useState, useEffect, useRef,useMemo } from "react";
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
  const [branches, setBranches] = useState([]);
  const memoizedBranches = useMemo(() => branches, [branches]); // ✅ Memoizing branches
  const [filteredBranches, setFilteredBranches] = useState([]);
  const memoizedFilteredBranches = useMemo(() => filteredBranches, [filteredBranches]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [activeChat, setActiveChat] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeBranchId, setActiveBranchId] = useState(null); // Track the active branch
  const mapRef = useRef(null);
  const branchRefs = useRef({}); // Store refs for each branch
  const branchListRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

    // 1️⃣ observe when the map container enters viewport
    useEffect(() => {
      const el = document.getElementById("map");
      if (!el) return;
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
          setMapReady(true);
          observer.disconnect();
        }
      }, { rootMargin: "200px" }); // preload slightly early
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

// 2️⃣ When mapReady flips true, fetch branches and dynamically load/map
useEffect(() => {
  if (!mapReady) return;
  let cancelled = false;

  const fetchAndInit = async () => {
    console.log("[DEBUG] Fetching branches…");
    try {
      // 2.a) fetch branch data
      const snap = await getDocs(collection(db, "branches"));
      const data = snap.docs.map(doc => ({
        id: doc.id,
        hasJewelryDisplay: doc.data().hasJewelryDisplay ?? false,
        ...doc.data(),
      }));
      if (cancelled) return;
      setBranches(data);
      setFilteredBranches(data);

      // 2.b) dynamically import our heavy map utils
      const { initializeMap, updateMarkers, fitMapToBounds } = await import(
        "../utils/mapUtils"
      );

      // 2.c) initialize, draw markers, then zoom to fit
      await initializeMap(data, mapRef, branchData => {
        if (cancelled) return;
        updateMarkers(
          branchData,
          mapRef,
          setActiveBranchId,
          handleBranchClickFromList
        );
      });
      if (cancelled) return;
      fitMapToBounds(data, mapRef);
    } catch (err) {
      if (!cancelled) console.error("[ERROR] Failed to load branches:", err);
    }
  };

  fetchAndInit();

  return () => {
    cancelled = true;
  };
}, [mapReady]);

// 2️⃣ Debounced search + filter
const searchTimeoutRef = useRef(null);
const handleSearchAndFilter = () => {
  if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
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
    const listToShow = filtered.length ? filtered : memoizedBranches;
    if (JSON.stringify(listToShow) !== JSON.stringify(memoizedFilteredBranches)) {
      setFilteredBranches(listToShow);
      updateMarkers(
        listToShow,
        mapRef,
        setActiveBranchId,
        handleBranchClickFromList
      );
      fitMapToBounds(listToShow, mapRef);
    }
  }, 500);
};

useEffect(() => {
  handleSearchAndFilter();
}, [searchQuery, filter, memoizedBranches]);

// 3️⃣ When you click a list item, recenter + zoom
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
    setActiveBranchId(null); // Clear highlight when filter changes
  };
  
  // In Branches-List-User-Page.js (inside your component)

const openChatBox = async (branch) => {
  try {
    // 1) Try to restore from sessionStorage/localStorage
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

    // 2a) If JS storage is empty but we still have an HttpOnly cookie → REFRESH
    const cookieMatch = document.cookie.match(/(?:^|; )guestToken=([^;]+)/);
    const cookieToken = cookieMatch?.[1];
    if (!guestId && !guestToken && cookieToken) {
      console.log("[GUEST] 🍪 Found HTTP-only cookie, REFRESH guest token");
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

    // 2b) If absolutely no session and no cookie → INIT new guest
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
          }),
        }
      );
      if (!res.ok) throw new Error("Guest init failed");
      const data = await res.json();
      guestId    = data.guestId;
      guestToken = data.token;

    // 3) If we have an ID but no token → REFRESH
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

    // 4) Persist both values in sessionStorage+localStorage
    sessionStorage.setItem("guestId",    guestId);
    sessionStorage.setItem("guestToken", guestToken);
    localStorage.setItem("guestId",      guestId);
    localStorage.setItem("guestToken",   guestToken);

    console.log(`[SOCKET] Opening chatbox for guestId: ${guestId}`);

    // 5) Normal socket and UI setup
    sessionStorage.setItem("branchEmail", branch.email);
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
      guestId,
    });

  } catch (err) {
    console.error("[SOCKET] ❌ Failed to open guest chat:", err);
    alert("Could not open chat. Please try again later.");
  }
};
  

// ✅ Cleanly close chatbox (manual button click)
const closeChatBox = () => {
  console.log("[SOCKET] Closing chatbox...");

  sessionStorage.removeItem("chatOpen"); // 🧼 Mark chat closed
  disconnectSocket(false, "manual");     // 🧷 Retain session
  setActiveChat(null);
};


return (
  <div className="container min-h-screen flex flex-col items-center justify-center bg-gray-100">
    <div className="w-full max-w-5xl h-[700px] bg-white rounded-lg shadow-md border flex flex-col">
      
      {/* 🌍 Google Map */}
      <div
        id="map"
        className={`map-container ${filteredBranches.length === 0 ? 'reduced-height' : ''}`}
      >
        {!mapReady && (
          <div className="map-placeholder">
            Scroll to load map…
          </div>
        )}
      </div>

      {/* 🔍 Search & Filters */}
      <div className="search-filter-container">
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
      <div
        className="branch-list"
        ref={branchListRef}
      >
        {isLoading ? (
          <p className="no-results">Loading branches...</p>
        ) : filteredBranches.length === 0 ? (
          <p className="no-results">Loading branches...</p>
        ) : (
          filteredBranches.map((branch) => (
            <div
              key={branch.id}
              ref={(el) => (branchRefs.current[branch.id] = el)}
              className={`branch-item ${branch.id === activeBranchId ? "active" : ""}`}
              onClick={() => handleBranchClickFromList(branch)}
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
                  e.stopPropagation(); // Prevent triggering branch click
                  openChatBox(branch);
                }}
              >
                Chat with {branch.name}
              </button>
            </div>
          ))
        )}
      </div>
    </div>

    {/* 💬 Chat Overlay */}
    {activeChat && (
      <GuestChatBox
        branchId={activeChat.branchId}
        branchEmail={activeChat.branchEmail}
        branchName={activeChat.branchName}
        guestId={activeChat.guestId}
        onClose={closeChatBox} // ✅ Calls disconnect only once
      />
    )}
  </div>
);
}

export default BranchesMapView;