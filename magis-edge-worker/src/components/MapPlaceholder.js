import React from 'react';

export default function MapPlaceholder({ center, zoom, markers, onLoad }) {
  const markerParams = markers.map(m => `${m.lat},${m.lng}`).join('|');
  const src = `https://maps.googleapis.com/maps/api/staticmap?center=${center.lat},${center.lng}&zoom=${zoom}&size=600x300&markers=${markerParams}&key=${process.env.REACT_APP_GOOGLE_MAPS_API_KEY}`;
  return (
    <div>
      <img src={src} alt="Map preview" style={{ width: '100%' }} />
      <button onClick={onLoad}>Load Interactive Map</button>
    </div>
  );
}