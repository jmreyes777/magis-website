//magis-project/admin-frontend/src/utils/mapsLoader.js

let googleMapsPromise = null;

export const loadGoogleMapsApi = (params = {}) => {
  if (!googleMapsPromise) {
    googleMapsPromise = new Promise((resolve, reject) => {
      // Check if the script is already injected
      if (document.querySelector(`script[src*="maps.googleapis.com/maps/api/js"]`)) {
        if (window.google?.maps) {
          resolve(window.google.maps);
        } else {
          reject(new Error("Google Maps API script already loaded but not initialized."));
        }
        return;
      }

      // Inject the Google Maps API script with Map ID and parameters
      const script = document.createElement("script");
      const librariesParam = params.libraries ? `&libraries=${params.libraries}` : "";
      script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.REACT_APP_GOOGLE_MAPS_API_KEY}&v=weekly&loading=async&map_ids=11200911213e8d86${librariesParam}`;
      script.async = true;
      script.defer = true;

      script.onload = () => {
        if (window.google?.maps) {
          resolve(window.google.maps);
        } else {
          reject(new Error("Google Maps API failed to load. Please check your API key or quota limits."));
        }
      };

      script.onerror = (error) => {
        console.error("Failed to load Google Maps API:", error);
        reject(new Error("Failed to load Google Maps API."));
      };

      document.head.appendChild(script);
    });
  }

  return googleMapsPromise;
};