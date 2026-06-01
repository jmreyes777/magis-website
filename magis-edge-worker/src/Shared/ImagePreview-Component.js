//magis-project/user-frontend/src/Shared/ImagePreview-Component.js

import React, { useState, useEffect } from 'react';
import { optimizeImage } from './Utils-imageOptimization';

const ImagePreview = ({ file, onCancel, onUpload }) => {
  const [previewSrc, setPreviewSrc] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  // Generate a preview of the image when file changes
  useEffect(() => {
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreviewSrc(e.target.result);
      };
      reader.readAsDataURL(file);
    }
  }, [file]);

  // Handle the upload process
  const handleUpload = async () => {
    try {
      setIsUploading(true);
      const optimizedImage = await optimizeImage(file);
  
      if (typeof onUpload === "function") {
        onUpload(optimizedImage);
        onCancel(); 
      } else {
        console.warn("[ImagePreview] ⚠️ onUpload callback not provided.");
      }
    } catch (error) {
      console.error("Error optimizing image:", error);
      alert("Failed to optimize image. Please try again.");
    } finally {
      setIsUploading(false);
    }
  };

  if (!file) return null;

  return (
    <div
      className="image-preview"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '400px',
        backgroundColor: '#fff',
        boxShadow: '0 4px 8px rgba(0, 0, 0, 0.2)',
        borderRadius: '8px',
        overflow: 'hidden',
        zIndex: 1000,
      }}
    >
      {/* Preview Header */}
      <div
        style={{
          padding: '10px',
          backgroundColor: '#007BFF',
          color: '#fff',
          fontWeight: 'bold',
          textAlign: 'center',
        }}
      >
        Image Preview
      </div>

      {/* Image Preview */}
      <div
        style={{
          padding: '10px',
          textAlign: 'center',
        }}
      >
        {previewSrc ? (
          <img
            src={previewSrc}
            alt="Preview"
            style={{
              maxWidth: '100%',
              maxHeight: '200px',
              objectFit: 'cover',
              borderRadius: '5px',
            }}
          />
        ) : (
          <p>Loading preview...</p>
        )}
      </div>

      {/* Action Buttons */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '10px',
          backgroundColor: '#f5f5f5',
          borderTop: '1px solid #ddd',
        }}
      >
        <button
          onClick={onCancel}
          style={{
            padding: '10px 15px',
            backgroundColor: '#ff5e57',
            color: '#fff',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
          }}
          disabled={isUploading}
        >
          Cancel
        </button>
        <button
          onClick={handleUpload}
          style={{
            padding: '10px 15px',
            backgroundColor: '#28a745',
            color: '#fff',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
          }}
          disabled={isUploading}
        >
          {isUploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>
    </div>
  );
};

export default ImagePreview;