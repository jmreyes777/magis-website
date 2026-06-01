// src/Launcher.js
import React from 'react';
export default function Launcher() {
  const isElectron = () =>
    navigator.userAgent.toLowerCase().includes('electron');

  // If we’re already in Electron, skip straight into the app
  if (isElectron()) window.location.replace('/admin/chats');

  return (
    <div style={{ textAlign: 'center', marginTop: '20vh' }}>
      <h1>Magis Admin</h1>
      <p>How would you like to run the app?</p>
      <div style={{ margin: '2rem' }}>
        <a
          href="/admin/chats"
          style={{
            display: 'inline-block',
            padding: '1rem 2rem',
            marginRight: '1rem',
            background: '#007bff',
            color: 'white',
            borderRadius: '4px',
            textDecoration: 'none',
          }}
        >
          Open in Browser
        </a>

        {/* This deep-link only works if the Electron app has registered the protocol */}
        <a
          href="magisadmin://open"
          style={{
            display: 'inline-block',
            padding: '1rem 2rem',
            background: '#28a745',
            color: 'white',
            borderRadius: '4px',
            textDecoration: 'none',
          }}
        >
          Open Desktop App
        </a>
      </div>
    </div>
  );
}
