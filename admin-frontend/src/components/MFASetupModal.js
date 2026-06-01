/**
 * MFA Setup Modal Component
 * Guides admin through TOTP MFA enrollment
 */

import React, { useState, useEffect } from 'react';

const MFASetupModal = ({ isOpen, onClose, onComplete }) => {
  const [step, setStep] = useState(1); // 1: QR Code, 2: Verify, 3: Backup Codes
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [backupCodes, setBackupCodes] = useState([]);
  const [verificationCode, setVerificationCode] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null);

  useEffect(() => {
    if (isOpen) {
      fetchSetupData();
    }
  }, [isOpen]);

  const fetchSetupData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const token = sessionStorage.getItem('branchAdminToken') || 
                   localStorage.getItem('branchAdminToken');
      
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/setup`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to setup MFA');
      }
      
      setQrCode(data.qrCode);
      setSecret(data.manualEntryKey);
      setBackupCodes(data.backupCodes);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    if (!verificationCode || verificationCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      
      const token = sessionStorage.getItem('branchAdminToken') || 
                   localStorage.getItem('branchAdminToken');
      
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/mfa/verify-setup`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        credentials: 'include',
        body: JSON.stringify({ code: verificationCode }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Verification failed');
      }
      
      setStep(3); // Move to backup codes step
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (code, index) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(index);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const downloadBackupCodes = () => {
    const content = `Magis Pawnshop - MFA Backup Codes
Generated: ${new Date().toLocaleString()}
Store these codes in a safe place. Each code can only be used once.

${backupCodes.join('\n')}

IMPORTANT:
- Keep these codes confidential
- Do not store them on your computer
- Use them only when you cannot access your authenticator app`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'magis-mfa-backup-codes.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const completeSetup = () => {
    onComplete();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">
            {step === 1 && 'Setup Multi-Factor Authentication'}
            {step === 2 && 'Verify Your Code'}
            {step === 3 && 'Save Backup Codes'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl"
            disabled={loading}
          >
            ×
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="text-center py-4">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-gray-600">Loading...</p>
          </div>
        )}

        {/* Step 1: QR Code */}
        {step === 1 && !loading && (
          <div>
            <p className="text-gray-600 mb-4">
              Scan this QR code with your authenticator app (Google Authenticator, Authy, or Microsoft Authenticator):
            </p>
            
            {qrCode && (
              <div className="flex justify-center mb-4">
                <img 
                  src={qrCode} 
                  alt="MFA QR Code" 
                  className="border rounded p-2"
                  style={{ maxWidth: '200px' }}
                />
              </div>
            )}
            
            <div className="bg-gray-100 p-3 rounded mb-4">
              <p className="text-sm text-gray-600 mb-1">Manual entry key:</p>
              <code className="text-sm bg-white px-2 py-1 rounded border break-all">
                {secret}
              </code>
            </div>
            
            <button
              onClick={() => setStep(2)}
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
              disabled={loading}
            >
              I've scanned the code →
            </button>
          </div>
        )}

        {/* Step 2: Verify Code */}
        {step === 2 && !loading && (
          <div>
            <p className="text-gray-600 mb-4">
              Enter the 6-digit code from your authenticator app to verify:
            </p>
            
            <input
              type="text"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="w-full border rounded px-3 py-2 text-center text-2xl tracking-widest mb-4"
              maxLength={6}
            />
            
            <div className="flex gap-2">
              <button
                onClick={() => setStep(1)}
                className="flex-1 bg-gray-200 text-gray-700 py-2 rounded hover:bg-gray-300"
                disabled={loading}
              >
                ← Back
              </button>
              <button
                onClick={verifyCode}
                className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
                disabled={verificationCode.length !== 6 || loading}
              >
                Verify →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Backup Codes */}
        {step === 3 && !loading && (
          <div>
            <div className="bg-yellow-50 border border-yellow-400 rounded p-3 mb-4">
              <p className="text-yellow-800 text-sm">
                <strong>⚠️ Important:</strong> Save these backup codes in a safe place. 
                Each code can only be used once if you lose access to your authenticator app.
              </p>
            </div>
            
            <div className="grid grid-cols-2 gap-2 mb-4">
              {backupCodes.map((code, index) => (
                <button
                  key={index}
                  onClick={() => copyToClipboard(code, index)}
                  className={`font-mono text-sm p-2 rounded border text-center ${
                    copiedCode === index 
                      ? 'bg-green-100 border-green-400 text-green-700' 
                      : 'bg-gray-50 border-gray-300 hover:bg-gray-100'
                  }`}
                >
                  {copiedCode === index ? 'Copied!' : code}
                </button>
              ))}
            </div>
            
            <div className="flex gap-2 mb-4">
              <button
                onClick={downloadBackupCodes}
                className="flex-1 bg-gray-100 text-gray-700 py-2 rounded hover:bg-gray-200 text-sm"
              >
                📥 Download as file
              </button>
            </div>
            
            <p className="text-sm text-gray-500 mb-4">
              Click any code to copy it. We recommend printing or writing these down and storing them securely.
            </p>
            
            <button
              onClick={completeSetup}
              className="w-full bg-green-600 text-white py-2 rounded hover:bg-green-700"
            >
              I've saved my backup codes ✓
            </button>
          </div>
        )}

        {/* Progress indicator */}
        <div className="flex justify-center gap-2 mt-6">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-2 w-2 rounded-full ${
                s === step ? 'bg-blue-600' : s < step ? 'bg-green-600' : 'bg-gray-300'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default MFASetupModal;
