// magis-project/user-frontend/src/utils/googleMapsLoader.js

import { Loader } from "@googlemaps/js-api-loader";

const loader = new Loader({
  apiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY,
  version: "weekly",
  mapIds: ["11200911213e8d86"],
  // no need to specify `libraries` here when using importLibrary()
});

export async function loadGoogleMapsApi(params = {}) {
  // Always load the core “maps” library, plus any extras the caller requested:
  const libs = ["maps", ...(params.libraries || [])];

  // Dynamically import each library; the first importLibrary call
  // bootstraps the script, and the rest load incremental code.
  await Promise.all(libs.map((lib) => loader.importLibrary(lib)));

  // Once done, window.google.maps is ready
  return window.google.maps;
}
