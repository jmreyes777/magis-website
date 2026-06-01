// src/pages/NotFound.js
import React from 'react';
import { Link } from 'react-router-dom';
import { FaHome } from 'react-icons/fa';

const NotFound = () => {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '4rem 2rem',
        fontFamily: 'Arial, sans-serif',
        backgroundColor: '#f8f9fa',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <h1 style={{ fontSize: '3rem', color: '#dc3545', marginBottom: '1rem' }}>
        404 - Page Not Found
      </h1>
      <p style={{ fontSize: '1.2rem', color: '#6c757d', marginBottom: '2rem' }}>
        Oops! The page you're looking for doesn't exist or has been moved.
      </p>
      <Link
        to="/"
        style={{
          textDecoration: 'none',
          color: '#fff',
          backgroundColor: '#007bff',
          padding: '0.75rem 1.5rem',
          borderRadius: '5px',
          fontSize: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          transition: 'background-color 0.3s ease',
        }}
        aria-label="Go back to the homepage"
      >
        <FaHome /> Go Back Home
      </Link>
    </div>
  );
};

export default NotFound;