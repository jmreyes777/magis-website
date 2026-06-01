/**
 * MFA Verification Modal
 * Prompts for MFA code when accessing SPI (Sensitive Personal Information)
 */

import React, { useState, useEffect } from 'react';

const MFAVerifyModal = ({ isOpen, onVerify, onCancel, operation = 'access sensitive data' }) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [usingBackupCode, setUsingBackupCode] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCode('');
      setError(null);
      setUsingBackupCode(false);
    }
  }, [isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!code.trim()) {
      setError('Please enter a code');
      return;
    }
    
    // Validate format
    if (usingBackupCode) {
      if (!/^[A-F0-9]{8}$/i.test(code)) {
        setError('Backup code must be 8 characters (letters and numbers)');
        return;
      }
    } else {
      if (!/^\d{6}$/.test(code)) {
        setError('Please enter a 6-digit code');
        return;
      }
    }
    
    try {
      setLoading(true);
      setError(null);
      
      const token = sessionStorage.getItem('branchAdminToken') || 
                   localStorage.getItem('branchAdminToken');
      
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/verify`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        credentials: 'include',
        body: JSON.stringify({ code }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Verification failed');
      }
      
      onVerify(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-sm w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-center mb-4">
          <div className="bg-blue-100 p-3 rounded-full">
            <svg 
              viewBox="0 0 24 24" 
              width="32" 
              height="32" 
              fill="#2563EB"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
        </div>
        
        <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
          Security Verification Required
        </h2>
        
        <p className="text-gray-600 text-center mb-4 text-sm">
          Multi-factor authentication is required to {operation}.
          This protects sensitive personal information under DPA 2012.
        </p>

        {/* Error */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-3 py-2 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Code Input */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {usingBackupCode ? 'Backup Code' : '6-Digit Authenticator Code'}
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => {
                const val = e.target.value.toUpperCase();
                if (usingBackupCode) {
                  setCode(val.replace(/[^A-F0-9]/g, '').slice(0, 8));
                } else {
                  setCode(val.replace(/\D/g, '').slice(0, 6));
                }
              }}
              placeholder={usingBackupCode ? 'XXXXXXXX' : '000000'}
              className={`w-full border rounded px-3 py-2 text-center tracking-widest ${
                usingBackupCode ? 'text-base' : 'text-xl'
              }`}
              maxLength={usingBackupCode ? 8 : 6}
              autoFocus
            />
          </div>

          {/* Toggle Backup Code */}
          <div className="flex justify-between items-center mb-4">
            <button
              type="button"
              onClick={() => {
                setUsingBackupCode(!usingBackupCode);
                setCode('');
                setError(null);
              }}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              {usingBackupCode ? 'Use authenticator code' : 'Use backup code'}
            </button>
            
            {usingBackupCode && (
              <span className="text-xs text-gray-500">
                8-character recovery code
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 bg-gray-200 text-gray-700 py-2 rounded hover:bg-gray-300"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
              disabled={loading || code.length !== (usingBackupCode ? 8 : 6)}
            >
              {loading ? (
                <span className="inline-flex items-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Verifying...
                </span>
              ) : (
                'Verify'
              )}
            </button>
          </div>
        </form>

        {/* Info */}
        <p className="text-xs text-gray-500 text-center mt-4">
          This verification is required under the Philippine Data Privacy Act of 2012 (RA 10173) 
          to protect sensitive personal information.
        </p>
      </div>
    </div>
  );
};

export default MFAVerifyModal;
