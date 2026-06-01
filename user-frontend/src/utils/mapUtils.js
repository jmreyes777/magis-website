import { loadGoogleMapsApi } from "../utils/googleMapsLoader";

// Default zoom when map first loads
export const DEFAULT_ZOOM_OUT_LEVEL = 9;

// Bounds for the Philippines
export const MAP_BOUNDS = {
  north: 19.0,
  south: 4.5,
  east: 126.6,
  west: 116.8,
};

// Max zoom for a single branch
export const MAX_ZOOM_LEVEL = 20;

/**
 * Initialize the Google Map.
 * @param {Array} branchData
 * @param {Object} mapRef        – React ref object to assign map instance to
 * @param {Function} onMapReady – callback(branchData)
 */
export async function initializeMap(branchData, mapRef, onMapReady) {
  console.log("[mapUtils] Initializing map…");
  if (!branchData?.length) {
    console.error("[mapUtils] No branch data to initialize map.");
    return;
  }
  try {
    const googleMaps = await loadGoogleMapsApi({ libraries: ["places", "marker"] });
    const mapDiv = document.getElementById("map");
    mapDiv.style.touchAction = "pan-x pan-y";

    const mapInstance = new googleMaps.Map(mapDiv, {
      zoom: DEFAULT_ZOOM_OUT_LEVEL,
      center: { lat: 14.5995, lng: 120.9842 },
      mapId: process.env.REACT_APP_GOOGLE_MAPS_MAP_ID || "11200911213e8d86",
      gestureHandling: "auto",    // ← allow wheel zoom and touch gestures
      restriction: {
        latLngBounds: MAP_BOUNDS,
        strictBounds: false,
      },
    });

    mapRef.current = {
      map: mapInstance,
      googleMaps,
      markers: [],
    };
    console.log("[mapUtils] Map ready:", mapRef.current);

    if (typeof onMapReady === "function") {
      onMapReady(branchData);
    } else {
      console.warn("[mapUtils] onMapReady is not a function");
    }
  } catch (error) {
    console.error("[mapUtils] Error initializing map:", error);
  }
}

/**
 * Update markers on the map.
 * @param {Array} branchData
 * @param {Object} mapRef
 * @param {Function} setActiveBranchId
 * @param {Function} handleBranchClickFromList
 */
export function updateMarkers(
  branchData,
  mapRef,
  setActiveBranchId,
  handleBranchClickFromList
) {
  const ctx = mapRef.current;
  if (!ctx?.map || !ctx?.googleMaps?.marker?.AdvancedMarkerElement) return;

  const { map, googleMaps, markers: oldMarkers } = ctx;
  const oldIds = new Set(oldMarkers.map(m => m.branchId));

  // Clear all if no data
  if (branchData.length === 0) {
    oldMarkers.forEach(m => m.setMap(null));
    ctx.markers = [];
    return;
  }

  // Only rebuild if list changed
  if (
    oldMarkers.length !== branchData.length ||
    !branchData.every(b => oldIds.has(b.id))
  ) {
    oldMarkers.forEach(m => m.setMap(null));
    ctx.markers = [];

    branchData.forEach(branch => {
      if (branch.location?.lat && branch.location?.lng) {
        const marker = new googleMaps.marker.AdvancedMarkerElement({
          position: branch.location,
          map,
          title: branch.name,
        });
        marker.branchId = branch.id;

        marker.addListener("gmp-click", () => {
          map.setCenter(branch.location);
          map.setZoom(MAX_ZOOM_LEVEL);
          setActiveBranchId(branch.id);
          handleBranchClickFromList(branch);
        });

        ctx.markers.push(marker);
      }
    });
  }
}

/**
 * Fit the map viewport to include all branch locations.
 * @param {Array} branchData
 * @param {Object} mapRef
 */
export function fitMapToBounds(branchData, mapRef) {
  const ctx = mapRef.current;
  if (!ctx?.map) return;

  const bounds = new google.maps.LatLngBounds();
  let hasAny = false;
  branchData.forEach(branch => {
    if (branch.location?.lat && branch.location?.lng) {
      bounds.extend(branch.location);
      hasAny = true;
    }
  });
  if (hasAny) {
    const inst = ctx.map;
    const current = inst.getBounds();
    if (!current || !current.equals(bounds)) {
      inst.fitBounds(bounds);
    }
  }
}
