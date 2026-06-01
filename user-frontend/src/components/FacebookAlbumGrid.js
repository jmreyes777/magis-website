import React, { useEffect, useState } from "react";

const API_BASE =
  (process.env.REACT_APP_API_URL &&
    process.env.REACT_APP_API_URL.replace(/\/$/, "")) ||
  "";

/**
 * Displays a responsive grid of photos from Facebook.
 * If `albumId` is provided, loads that album's photos.
 * If `albumId` is omitted, automatically loads the LATEST album's photos.
 */
export default function FacebookAlbumGrid({ albumId, pageSize = 12 }) {
  const [photos, setPhotos] = useState([]);
  const [albumInfo, setAlbumInfo] = useState({ albumId: albumId || null });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(pageSize);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        if (!API_BASE) throw new Error("Missing REACT_APP_API_URL");
        let url;
        if (albumId) {
          url = `${API_BASE}/api/facebook/album/${encodeURIComponent(albumId)}/photos`;
        } else {
          url = `${API_BASE}/api/facebook/albums/latest/photos`;
        }

        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error || data?.message || `HTTP ${res.status}`;
          throw new Error(msg);
        }

        const list = Array.isArray(data?.photos) ? data.photos : [];
        if (mounted) {
          setPhotos(list);
          if (data?.albumId) setAlbumInfo({ albumId: data.albumId });
        }
      } catch (e) {
        console.error("[FacebookAlbumGrid] Fetch failed:", e);
        if (mounted) setError("Unable to load catalog photos at the moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    return () => { mounted = false; };
  }, [albumId]);

  if (loading) return <div className="text-gray-500">Loading catalog…</div>;
  if (error)   return <div className="text-red-500">{error}</div>;
  if (!photos.length) return <div className="text-gray-500">No catalog items found.</div>;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {photos.slice(0, visibleCount).map((p) => {
          const imgSrc = p.images?.[0]?.src || "";
          return (
            <a
              key={p.id}
              href={p.permalink_url || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="block group"
              title={p.caption || "View on Facebook"}
            >
              <div className="relative overflow-hidden rounded shadow-md bg-gray-100 aspect-square">
                <img
                    src={imgSrc}
                    alt={p.caption || "Catalog item"}
                    className="w-full h-full object-cover group-hover:scale-105 transition-all duration-300"
                    style={{
                        filter: "brightness(1.1) contrast(1.15) saturate(1.2)",
                        willChange: "filter, transform",
                    }}
                    loading="lazy"
                    />
              </div>
            </a>
          );
        })}
      </div>

      {visibleCount < photos.length && (
        <div className="col-span-full text-center mt-6">
          <button
            onClick={() => setVisibleCount((v) => v + pageSize)}
            className="px-4 py-2 bg-yellow-500 text-black font-medium rounded hover:bg-yellow-600 transition"
          >
            Load More
          </button>
        </div>
      )}
    </>
  );
}
