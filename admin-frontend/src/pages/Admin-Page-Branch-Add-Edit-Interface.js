//magis-project/admin-frontend/src/pages/Admin-Page-Branch-Add-Edit-Interface.js

import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import TimePicker from "react-time-picker";
import "react-time-picker/dist/TimePicker.css";
import { db } from "../firebase-config";
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from "firebase/firestore";
import { loadGoogleMapsApi } from "../utils/mapsLoader";

const mapContainerStyle = { width: "100%", height: "300px" };
const center = { lat: 14.5995, lng: 120.9842 };
const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function BranchManagement() {
  const { branchId } = useParams();
  const navigate = useNavigate();
  const isEditing = Boolean(branchId);

  const [googleMaps, setGoogleMaps] = useState(null);
  const [branch, setBranch] = useState({
    name: "",
    phone: "",
    email: "",
    location: { lat: center.lat, lng: center.lng },
    address: "",
    actualAddress: "",
    schedule: DAYS_OF_WEEK.map((day) => ({
      day,
      open: false,
      openTime: "09:00",
      closeTime: "17:00",
    })),
    hasJewelryDisplay: false,
  });

  const [interestRates, setInterestRates] = useState([
    { id: 1, range: "1-10 Days", rate: 1 },
    { id: 2, range: "11-20 Days", rate: 1.5 },
    { id: 3, range: "21-30 Days", rate: 2 },
    { id: 4, range: "31-40 Days", rate: 2.5 },
    { id: 5, range: "41-50 Days", rate: 3 },
  ]);

  const [newRange, setNewRange] = useState("");
  const [newRate, setNewRate] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const autocompleteRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const zoomLevelRef = useRef(15);

  const initializeGoogleMaps = async () => {
    if (!mapRef.current) {
      console.error("Map container is not initialized in the DOM.");
      return;
    }

    try {
      const loadedGoogleMaps = await loadGoogleMapsApi({
        libraries: "places,marker",
      });
      setGoogleMaps(loadedGoogleMaps);

      const map = new loadedGoogleMaps.Map(mapRef.current, {
        center: branch.location,
        zoom: zoomLevelRef.current,
        mapId: "11200911213e8d86",
      });

      const MarkerClass = loadedGoogleMaps.marker?.AdvancedMarkerElement;
      const marker = MarkerClass
        ? new MarkerClass({
            map,
            position: branch.location,
          })
        : new loadedGoogleMaps.Marker({
            position: branch.location,
            map,
          });

      markerRef.current = marker;

      map.addListener("click", (event) => {
        const { lat, lng } = event.latLng.toJSON();
        zoomLevelRef.current = map.getZoom();
        setBranch((prev) => ({ ...prev, location: { lat, lng } }));
        setIsDirty(true);

        const geocoder = new loadedGoogleMaps.Geocoder();
        geocoder.geocode({ location: { lat, lng } }, (results, status) => {
          if (status === "OK" && results[0]) {
            setBranch((prev) => ({ ...prev, address: results[0].formatted_address }));
            if (MarkerClass) {
              marker.position = { lat, lng };
            } else {
              marker.setPosition({ lat, lng });
            }
          }
        });
      });

      // ✅ Places autocomplete on the "Google Maps Address" input — picking a
      // suggestion moves the pin (map re-centers via the location effect).
      // Guarded so re-inits (map click → location change → effect) don't stack
      // duplicate autocomplete widgets on the same input element.
      if (
        autocompleteRef.current &&
        loadedGoogleMaps.places &&
        !autocompleteRef.current.dataset.acReady
      ) {
        const ac = new loadedGoogleMaps.places.Autocomplete(autocompleteRef.current, {
          fields: ["formatted_address", "geometry"],
          componentRestrictions: { country: "ph" },
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          if (!place?.geometry?.location) return;
          const { lat, lng } = place.geometry.location.toJSON();
          setBranch((prev) => ({
            ...prev,
            address: place.formatted_address || prev.address,
            location: { lat, lng },
          }));
          setIsDirty(true);
        });
        autocompleteRef.current.dataset.acReady = "1";
      }

      mapRef.current.map = map;
    } catch (err) {
      setError("Failed to load Google Maps API. Ensure your API key is valid.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const fetchBranch = async () => {
      setIsLoading(true);
      if (isEditing) {
        try {
          const branchDoc = await getDoc(doc(db, "branches", branchId));
          if (!branchDoc.exists()) throw new Error("Branch not found.");
    
          const data = branchDoc.data();
          setBranch({
            ...data,
            schedule: data.schedule || DAYS_OF_WEEK.map((day) => ({
              day,
              open: false,
              openTime: "09:00",
              closeTime: "17:00",
            })),
            interestRates: data.interestRates || [],
          });
    
        } catch (err) {
          setError("Branch not found. Redirecting...");
          setTimeout(() => navigate("/admin/branches"), 2000);
        }
      }
      setIsLoading(false);
    };

    fetchBranch();
  }, [branchId, isEditing, navigate]);

  useEffect(() => {
    if (mapRef.current && (isEditing || !isEditing)) {
      initializeGoogleMaps();
    }
  }, [branch.location, isEditing]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = ""; // Show a browser prompt for unsaved changes
      }
    };

    const handlePopState = (e) => {
      if (isDirty && !window.confirm("Are you sure? Changes will not be saved.")) {
        navigate(1);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isDirty, navigate]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setBranch((prev) => ({ ...prev, [name]: type === "checkbox" ? checked : value }));
    setIsDirty(true);
  };

  const handleDayChange = (index, field, value) => {
    const updatedSchedule = [...branch.schedule];
    updatedSchedule[index][field] = value;
    setBranch((prev) => ({ ...prev, schedule: updatedSchedule }));
    setIsDirty(true);
  };

  const addNewRate = () => {
    if (!newRange.trim() || !newRate) {
      setError("Please enter both a time range and a valid interest rate.");
      return;
    }
  
    const updatedRates = [
      ...branch.interestRates,
      { range: newRange.trim(), rate: parseFloat(newRate) }
    ];
  
    setBranch((prev) => ({ ...prev, interestRates: updatedRates }));
    setNewRange("");
    setNewRate("");
    setIsDirty(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
  
    if (!branch.name || !branch.email || !branch.address || !branch.phone || !branch.actualAddress) {
      setError("Name, email, phone, Google Maps address, and actual address are required.");
      setIsSubmitting(false);
      return;
    }
  
    try {
      const branchRef = doc(db, "branches", branchId || new Date().toISOString());
  
      // ✅ Ensure interestRates is included
      const updatedBranch = {
        ...branch,
        interestRates: branch.interestRates || [  // Default if not set
          { range: "1-10 days", rate: 1 },
          { range: "11-20 days", rate: 1.5 },
          { range: "21-30 days", rate: 2.0 },
        ],
      };
  
      if (isEditing) {
        await updateDoc(branchRef, updatedBranch);
      } else {
        await setDoc(branchRef, updatedBranch);
      }
  
      setIsDirty(false);
      navigate("/admin/branches");
    } catch (error) {
      setError("Failed to save branch. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };  
  const handleCustomBack = () => {
    if (isDirty && !window.confirm("Are you sure? Changes will not be saved.")) {
      return;
    }
    navigate("/admin/branches");
  };

  if (isLoading) return <p className="text-blue-500">Loading maps...</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">{isEditing ? "Edit Branch" : "Add Branch"}</h1>
      <button
        type="button"
        onClick={handleCustomBack}
        className="mb-4 text-blue-500 hover:text-blue-700"
      >
        Back to Branches
      </button>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          Branch Name:
          <input
            type="text"
            name="name"
            value={branch.name}
            onChange={handleChange}
            placeholder="Branch Name"
            required
            className="border p-2 w-full"
          />
        </label>
        <label className="block">
          Phone Number:
          <input
            type="text"
            name="phone"
            value={branch.phone}
            onChange={handleChange}
            placeholder="Phone Number"
            required
            className="border p-2 w-full"
          />
        </label>
        <label className="block">
          Branch Email:
          <input
            type="email"
            name="email"
            value={branch.email}
            onChange={handleChange}
            placeholder="Branch Email"
            required
            className="border p-2 w-full"
          />
        </label>
        <label className="block">
          Actual Address:
          <input
            type="text"
            name="actualAddress"
            value={branch.actualAddress || ""}
            onChange={handleChange}
            placeholder="Street, barangay, city — as posted at the branch"
            required
            className="border p-2 w-full"
          />
        </label>
        <label className="block">
          Google Maps Address:
          <input
            type="text"
            name="address"
            value={branch.address || ""}
            onChange={handleChange}
            ref={autocompleteRef}
            placeholder="Search a place, or click the map below to set it"
            required
            className="border p-2 w-full"
          />
        </label>
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            name="hasJewelryDisplay"
            checked={!!branch.hasJewelryDisplay}
            onChange={handleChange}
          />
          <span>Jewelry display at this branch</span>
        </label>
  
        {/* ✅ Read-Only Interest Rate Management Section */}
        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-2">Interest Rate Table (Preview)</h2>
          <div className="border p-4 rounded bg-gray-100">
            <table className="w-full border-collapse border">
              <thead>
                <tr className="bg-gray-200">
                  <th className="border p-2">Time Range</th>
                  <th className="border p-2">Interest Rate (%)</th>
                </tr>
              </thead>
              <tbody>
                {branch.interestRates
                  ?.filter(rate => rate?.range?.trim() && rate?.rate !== undefined)
                  .map((rate, index) => (
                    <tr key={index} className="text-center">
                      <td className="border p-2">{rate.range}</td>
                      <td className="border p-2">{rate.rate}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
  
        {/* ✅ Editable Interest Rate Section */}
        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-2">Edit Current Interest Rates</h2>
          <div className="border p-4 rounded bg-gray-100">
            <table className="w-full border-collapse border">
              <thead>
                <tr className="bg-gray-200">
                  <th className="border p-2">Time Range</th>
                  <th className="border p-2">Interest Rate</th>
                  <th className="border p-2 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(branch.interestRates || [])
                  .filter(rate => rate?.range?.trim() && rate?.rate !== undefined)
                  .map((rate, index) => (
                    <tr key={index} className="text-center">
                      <td className="border p-2">
                        <input
                          type="text"
                          value={rate.range}
                          onChange={(e) => {
                            const updatedRates = [...branch.interestRates];
                            updatedRates[index] = {
                              ...updatedRates[index],
                              range: e.target.value.trim(),
                            };
                            setBranch((prev) => ({ ...prev, interestRates: updatedRates }));
                            setIsDirty(true);
                          }}
                          className="border p-2 w-full"
                        />
                      </td>
                      <td className="border p-2">
                        <input
                          type="number"
                          value={rate.rate}
                          onChange={(e) => {
                            const updatedRates = [...branch.interestRates];
                            updatedRates[index] = {
                              ...updatedRates[index],
                              rate: parseFloat(e.target.value) || 0,
                            };
                            setBranch((prev) => ({ ...prev, interestRates: updatedRates }));
                            setIsDirty(true);
                          }}
                          className="border p-2 w-full"
                        />
                      </td>
                      <td className="border p-2 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            const updatedRates = branch.interestRates.filter((_, i) => i !== index);
                            if (updatedRates.length > 0) {
                              setBranch((prev) => ({ ...prev, interestRates: updatedRates }));
                              setIsDirty(true);
                            }
                          }}
                          className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
  
            {/* Add New Rate Section */}
            <div className="mt-4 flex space-x-2">
              <input
                type="text"
                placeholder="Enter Time Range (e.g., 1-10 Days)"
                value={newRange}
                onChange={(e) => setNewRange(e.target.value.trim())}
                className="border p-2 w-1/2"
              />
              <input
                type="number"
                placeholder="Enter Rate (%)"
                value={newRate}
                onChange={(e) => setNewRate(e.target.value)}
                className="border p-2 w-1/4"
              />
              <button
                type="button"
                onClick={() => {
                  if (newRange.trim() && newRate) {
                    setBranch((prev) => ({
                      ...prev,
                      interestRates: [
                        ...prev.interestRates,
                        { range: newRange.trim(), rate: parseFloat(newRate) },
                      ],
                    }));
                    setNewRange("");
                    setNewRate("");
                    setIsDirty(true);
                  }
                }}
                className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600"
              >
                Add Rate
              </button>
            </div>
          </div>
        </div>
  
        {/* ✅ Branch Schedule */}
        <div>
          <h2 className="text-xl font-semibold mb-2">Branch Schedule</h2>
          {(branch.schedule || []).map((day, index) => (
            <div key={day.day} className="flex items-center space-x-4 mb-2">
              <label className="w-20">{day.day}</label>
              <input
                type="checkbox"
                checked={day.open}
                onChange={(e) => handleDayChange(index, "open", e.target.checked)}
              />
              {day.open && (
                <>
                  <TimePicker
                    onChange={(value) => handleDayChange(index, "openTime", value)}
                    value={day.openTime}
                    disableClock
                    className="border rounded"
                  />
                  <TimePicker
                    onChange={(value) => handleDayChange(index, "closeTime", value)}
                    value={day.closeTime}
                    disableClock
                    className="border rounded"
                  />
                </>
              )}
            </div>
          ))}
        </div>
  
        {/* ✅ Map location editor — click to drop the pin (reverse-geocodes into the Google Maps Address field) */}
        <div>
          <h2 className="text-xl font-semibold mb-2">Map Location</h2>
          <p className="text-sm text-gray-600 mb-2">
            Click the map to set the exact branch location — the pin and the Google Maps Address update automatically.
          </p>
          <div id="map-container" style={mapContainerStyle} ref={mapRef} />
        </div>
        <button
          type="submit"
          className={`w-full px-6 py-2 text-white rounded ${
            isSubmitting ? "bg-gray-400" : "bg-green-500 hover:bg-green-600"
          }`}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving..." : isEditing ? "Update Branch" : "Add Branch"}
        </button>
      </form>
    </div>
  );      
}

export default BranchManagement;