//magis-project/admin-frontend/src/pages/Admin-Page-BranchesList-with-Add-Edit-Delete-buttons.js

import React, { useState, useEffect, useRef,useContext } from "react";
import { useNavigate } from "react-router-dom";
import { FaGem } from "react-icons/fa";
import { collection, getDoc,getDocs, deleteDoc, doc } from "firebase/firestore";
import { db } from "../firebase-config";
import { loadGoogleMapsApi } from "../utils/mapsLoader";
import "../styles/branchesList.css";
import AuthContext from "../context/AuthContext";  // adjust path if needed

const MAX_ZOOM_LEVEL = 20;
const DEFAULT_ZOOM_OUT_LEVEL = 9;

const formatTime = (time) => {
  const [hour, minute] = time.split(":").map(Number);
  const period = hour >= 12 ? "pm" : "am";
  const formattedHour = hour % 12 || 12;
  return `${formattedHour}:${minute.toString().padStart(2, "0")} ${period}`;
};

const formatSchedule = (schedule) => {
  if (!schedule || schedule.length === 0) return "No schedule available";

  const formatted = [];
  let startDay = null;
  let currentTime = null;

  schedule.forEach((day, index) => {
    if (day.open) {
      const timeRange = `${formatTime(day.openTime)} to ${formatTime(day.closeTime)}`;
      if (!currentTime || currentTime !== timeRange) {
        if (currentTime) {
          formatted.push(
            startDay === schedule[index - 1].day
              ? `${startDay}: ${currentTime}`
              : `${startDay} - ${schedule[index - 1].day}: ${currentTime}`
          );
        }
        startDay = day.day;
        currentTime = timeRange;
      }
    } else if (currentTime) {
      formatted.push(
        startDay === schedule[index - 1].day
          ? `${startDay}: ${currentTime}`
          : `${startDay} - ${schedule[index - 1].day}: ${currentTime}`
      );
      currentTime = null;
    }

    if (index === schedule.length - 1 && currentTime) {
      formatted.push(
        startDay === day.day
          ? `${startDay}: ${currentTime}`
          : `${startDay} - ${day.day}: ${currentTime}`
      );
    }
  });

  return formatted.join(", ");
};

function BranchesList() {
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedBranchRates, setSelectedBranchRates] = useState(null); // Stores fetched interest rates
  const [isModalOpen, setIsModalOpen] = useState(false); // Controls modal visibility

  const mapRef = useRef(null);
  const navigate = useNavigate();
  const { handleLogout } = useContext(AuthContext);

  useEffect(() => {
    const fetchBranches = async () => {
      try {
        console.log("[DEBUG] Fetching branches from Firestore...");
        const branchSnapshot = await getDocs(collection(db, "branches"));
        const branchData = branchSnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
  
        if (!branchData.length) {
          console.warn("[WARNING] No branches found in Firestore.");
        }
  
        setBranches(branchData);
      } catch (error) {
        console.error("[ERROR] Failed to fetch branches:", error);
        setError("Failed to load branches.");
      } finally {
        setIsLoading(false);
      }
    };
  
    fetchBranches();
  }, []);
  
  useEffect(() => {
    if (!branches.length) return;
  
    let retryCount = 0;
    const MAX_RETRIES = 5;
  
    const initializeMap = async () => {
      const mapContainer = document.getElementById("map");
  
      if (!mapContainer) {
        console.warn("[WARNING] Map container is not yet available in the DOM.");
        return;
      }
  
      try {
        console.log("[DEBUG] Attempting to load Google Maps API...");
        const googleMaps = await loadGoogleMapsApi({ libraries: ["places", "marker", "geometry"] });
  
        // ✅ Ensure `AdvancedMarkerElement` is available before proceeding
        if (!googleMaps.marker || !googleMaps.marker.AdvancedMarkerElement) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            console.warn(`[WARNING] AdvancedMarkerElement is not available. Retrying... (${retryCount}/${MAX_RETRIES})`);
            setTimeout(() => initializeMap(), 1000);
          } else {
            console.error("[ERROR] AdvancedMarkerElement failed to load after 5 attempts.");
          }
          return;
        }
  
        console.log("[SUCCESS] Google Maps API loaded successfully.");
        const map = new googleMaps.Map(mapContainer, {
          zoom: DEFAULT_ZOOM_OUT_LEVEL,
          center: { lat: 14.5995, lng: 120.9842 },
          mapId: process.env.REACT_APP_GOOGLE_MAPS_MAP_ID || "11200911213e8d86",
        });
  
        mapRef.current = { map, markers: [] };
  
        updateMarkers(branches, googleMaps.marker.AdvancedMarkerElement);
      } catch (error) {
        console.error("[ERROR] Failed to initialize Google Maps:", error);
      }
    };
  
    initializeMap();
  }, [branches]); // ✅ Depend on branches to initialize map after branches are loaded
  
  const updateMarkers = (branchData, AdvancedMarkerElement) => {
    if (!mapRef.current?.map) {
      console.error("[ERROR] Map reference is not initialized.");
      return;
    }
  
    const { map } = mapRef.current;
  
    // ✅ Clear existing markers before adding new ones
    if (mapRef.current.markers.length) {
      console.log("[DEBUG] Clearing existing markers...");
      mapRef.current.markers.forEach((marker) => marker.setMap(null));
    }
    mapRef.current.markers = [];
  
    branchData.forEach((branch) => {
      // ✅ Ensure `branch.location` has valid lat/lng
      if (!branch.location?.lat || !branch.location?.lng) {
        console.warn(`[WARNING] Skipping branch "${branch.name}" due to missing location data.`);
        return;
      }
  
      console.log(`[DEBUG] Adding marker for ${branch.name}...`);
      const marker = new AdvancedMarkerElement({
        position: branch.location,
        map,
        title: branch.name,
      });
  
      marker.addListener("click", () => {
        map.setCenter(branch.location);
        map.setZoom(MAX_ZOOM_LEVEL);
      });
  
      mapRef.current.markers.push(marker);
    });
  
    fitMapToBounds(branchData);
  };
  
  const fitMapToBounds = (branchData) => {
    if (!mapRef.current?.map) {
      console.error("[ERROR] Map reference is not initialized.");
      return;
    }
  
    const bounds = new google.maps.LatLngBounds();
    let hasValidLocations = false;
  
    branchData.forEach((branch) => {
      if (branch.location?.lat && branch.location?.lng) {
        bounds.extend(branch.location);
        hasValidLocations = true;
      }
    });
  
    if (hasValidLocations) {
      console.log("[DEBUG] Adjusting map bounds...");
      mapRef.current.map.fitBounds(bounds);
    } else {
      console.warn("[WARNING] No valid locations found to adjust bounds.");
    }
  };

  const [selectedBranchName, setSelectedBranchName] = useState(""); // Store the branch name

  const handleViewInterestRates = async (branchId) => {
    try {
      console.log(`[DEBUG] Fetching interest rates for branch ID: ${branchId}`);
      const branchRef = doc(db, "branches", branchId);
      const branchSnapshot = await getDoc(branchRef);
  
      if (!branchSnapshot.exists()) {
        console.error("[ERROR] Branch not found.");
        setError("Branch not found.");
        return;
      }
  
      const branchData = branchSnapshot.data();
      
      // 🔥 Filter out any blank or invalid interest rate entries
      const filteredRates = (branchData.interestRates || []).filter(
        (rate) => rate.range && rate.rate !== undefined && rate.range.trim() !== ""
      );
  
      setSelectedBranchRates(filteredRates);
      setSelectedBranchName(branchData.name || "Unknown Branch");
      setIsModalOpen(true);
    } catch (error) {
      console.error("[ERROR] Failed to fetch interest rates:", error);
      setError("Failed to load interest rates.");
    }
  };
  
  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedBranchRates(null);
  };  
  
  const handleDeleteBranch = async (id) => {
    if (!window.confirm("Are you sure you want to delete this branch?")) return;
  
    try {
      setIsDeleting(true);
      setBranches((prev) => prev.filter((branch) => branch.id !== id));
      await deleteDoc(doc(db, "branches", id));
      console.log(`[SUCCESS] Branch ID ${id} deleted.`);
    } catch (error) {
      console.error("[ERROR] Failed to delete the branch:", error);
      setError("Failed to delete the branch.");
    } finally {
      setIsDeleting(false);
    }
  };
  
  if (error) return <p className="error-text">{error}</p>;
  if (isLoading) return <p className="loading-text">Loading...</p>;  

  return (
    <div className="branches-container" style={{ position: "relative" }}>
      <h1 className="page-header">Branches List</h1>
  
      {/* Logout Button */}
      <button
      onClick={() => handleLogout(false)}
      className="btn btn-logout bg-red-600 text-white font-semibold"
      style={{
        position: "absolute",
        top: "1rem",
        right: "1rem",
        padding: "0.5rem 1rem",
        borderRadius: "0.25rem",
          }}
        >
          Logout
        </button>
  
      {/* Google Map */}
      <div id="map" style={{ width: "100%", height: "400px" }}></div>
  
      {branches.length > 0 ? (
        <table className="branches-table">
          <thead>
            <tr>
              <th>Branch Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Actual Address</th>
              <th>Google Maps Address</th>
              <th>Schedule</th>
              <th className="center">Jewelry Display</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => (
              <tr key={branch.id}>
                <td>{branch.name}</td>
                <td>{branch.phone || "N/A"}</td>
                <td>{branch.email}</td>
                <td>{branch.actualAddress || "N/A"}</td>
                <td>{branch.address || "N/A"}</td>
                <td>{branch.schedule ? formatSchedule(branch.schedule) : "No Schedule"}</td>
                <td className="center">
                  {branch.hasJewelryDisplay ? <FaGem className="text-yellow-500" /> : "No"}
                </td>
                <td>
                  <button
                    onClick={() => navigate(`/admin/branches/edit/${branch.id}`)}
                    className="btn btn-edit"
                  >
                    Edit
                  </button>
                  
                  {/* 🔹 View Interest Rates Button */}
                  <button
                    onClick={() => handleViewInterestRates(branch.id)}
                    className="btn btn-view"
                  >
                    View Interest Rates
                  </button>
  
                  <button
                    onClick={() => handleDeleteBranch(branch.id)}
                    className={`btn ${isDeleting ? "btn-disabled" : "btn-delete"}`}
                    disabled={isDeleting}
                  >
                    {isDeleting ? "Deleting..." : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="loading-text">No branches found.</p>
      )}
  
      <button onClick={() => navigate("/admin/branches/new")} className="btn btn-add">
        Add Branch
      </button>

      <button
        onClick={() => navigate("/admin/branch-passwords")}
        className="btn btn-add"
        style={{ marginLeft: "0.5rem" }}
      >
        Branch Login Passwords
      </button>

      <button
        onClick={() => navigate("/admin/audit")}
        className="btn btn-add"
        style={{ marginLeft: "0.5rem" }}
      >
        Audit &amp; Compliance Log
      </button>
  
      {/* 🔹 Interest Rates Modal */}
      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2 className="modal-title">
              Interest Rates for <span className="modal-branch-name">{selectedBranchName}</span>
            </h2>
            <table className="interest-rate-table">
              <thead>
                <tr>
                  <th>Time Range</th>
                  <th>Interest Rate (%)</th>
                </tr>
              </thead>
              <tbody>
                {selectedBranchRates.length > 0 ? (
                  selectedBranchRates.map((rate, index) => (
                    <tr key={index}>
                      <td>{rate.range}</td>
                      <td>{rate.rate}%</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="2" className="text-center">No interest rates found.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <button className="modal-close-btn" onClick={handleCloseModal}>Close</button>
          </div>
        </div>
      )}
    </div>
  );  
}

export default BranchesList;