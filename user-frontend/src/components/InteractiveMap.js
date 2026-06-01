import React, { useEffect, useRef } from "react";
import { loadGoogleMapsApi } from "../utils/googleMapsLoader";

export default function InteractiveMap({ branches }) {
  const containerRef = useRef();

  useEffect(() => {
    let map, googleMaps;
    loadGoogleMapsApi({ libraries: ["places","marker"] }).then(gm => {
      googleMaps = gm;
      // …initialize map & markers (same as before)…
    });
    return () => {
      if (map) googleMaps.event.clearInstanceListeners(map);
    };
  }, [branches]);

  return <div ref={containerRef} id="map" className="map-container" />;
}
