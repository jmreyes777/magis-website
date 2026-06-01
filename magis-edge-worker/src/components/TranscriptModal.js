// src/components/TranscriptModal.js

import React, { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";

const Modal = ({ children, isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6 relative">
        <button
          className="absolute top-3 right-3 text-gray-500 hover:text-gray-800"
          onClick={onClose}
          aria-label="Close"
        >
          ✖
        </button>
        {children}
      </div>
    </div>
  );
};

Modal.propTypes = {
  children: PropTypes.node.isRequired,
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};

const TranscriptModal = ({ isOpen, onClose, branchEmail, branchName }) => {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setEmail("");
      setMessage("");
      setImageFile(null);
      setImagePreview(null);
      setStatusMsg("");
    }
  }, [isOpen]);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onloadend = () => setImagePreview(reader.result);
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSend = async () => {
    if (!email.trim() || !message.trim()) {
      setStatusMsg("Email and message are required.");
      return;
    }
    setIsSending(true);
    setStatusMsg("");
    try {
      let imageBase64 = null;
      let imageName = null;
      if (imageFile) {
        imageBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(imageFile);
        });
        imageName = imageFile.name;
      }
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/guest/contact`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchEmail, branchName, guestEmail: email, message, imageBase64, imageName }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMsg("✅ Message sent successfully!");
        setEmail("");
        setMessage("");
        setImageFile(null);
        setImagePreview(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setTimeout(() => onClose(), 1800);
      } else {
        throw new Error(data.error || "Send failed");
      }
    } catch (err) {
      console.error("Contact form error:", err);
      setStatusMsg("❌ Failed to send. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <h2 className="text-xl font-semibold mb-2">Contact Branch</h2>
      <p className="text-sm text-gray-600 mb-4">
        Send a message directly to <strong>{branchName || branchEmail}</strong>.
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Your Email</label>
          <input
            type="email"
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            disabled={isSending}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Message</label>
          <textarea
            className="w-full border rounded px-3 py-2 text-sm resize-none"
            placeholder="Type your message..."
            rows={4}
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={isSending}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            Attach Image <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="w-full text-sm"
            onChange={handleImageChange}
            disabled={isSending}
          />
          {imagePreview && (
            <div className="relative inline-block mt-2">
              <img src={imagePreview} alt="Preview" className="w-20 h-20 object-cover rounded border" />
              <button
                type="button"
                onClick={handleRemoveImage}
                className="absolute -top-1.5 -right-1.5 bg-gray-800 bg-opacity-70 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center"
              >✕</button>
            </div>
          )}
        </div>
        {statusMsg && (
          <p className={`text-sm ${statusMsg.includes("✅") ? "text-green-600" : "text-red-500"}`}>{statusMsg}</p>
        )}
        <div className="flex justify-end space-x-2 pt-2">
          <button
            className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300 text-sm"
            onClick={onClose}
            disabled={isSending}
          >
            Cancel
          </button>
          <button
            className={`px-4 py-2 rounded text-white text-sm ${isSending || !email.trim() || !message.trim() ? "bg-blue-300 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700"}`}
            onClick={handleSend}
            disabled={isSending || !email.trim() || !message.trim()}
          >
            {isSending ? "Sending…" : "Send Message"}
          </button>
        </div>
      </div>
    </Modal>
  );
};

TranscriptModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  branchEmail: PropTypes.string.isRequired,
  branchName: PropTypes.string,
};

export default TranscriptModal;
