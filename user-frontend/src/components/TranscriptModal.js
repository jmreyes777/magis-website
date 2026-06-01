// src/components/TranscriptModal.js

import React, { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import "./TranscriptModal.css";

const Modal = ({ children, isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal-panel">
        <button className="modal-close-btn" onClick={onClose} aria-label="Close">✖</button>
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
      <h2 className="modal-title">Contact Branch</h2>
      <p className="modal-description">
        Send a message directly to <strong>{branchName || branchEmail}</strong>.
      </p>
      <div className="form-group">
        <div>
          <label className="form-label">Your Email</label>
          <input
            type="email"
            className="form-input"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            disabled={isSending}
          />
        </div>
        <div>
          <label className="form-label">Message</label>
          <textarea
            className="form-input"
            placeholder="Type your message..."
            rows={4}
            style={{ resize: "none" }}
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={isSending}
          />
        </div>
        <div>
          <label className="form-label">Attach Image <span style={{ fontWeight: "normal", color: "#888" }}>(optional)</span></label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="form-input"
            onChange={handleImageChange}
            disabled={isSending}
          />
          {imagePreview && (
            <div style={{ position: "relative", display: "inline-block", marginTop: "8px" }}>
              <img src={imagePreview} alt="Preview" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, border: "1px solid #ddd" }} />
              <button
                type="button"
                onClick={handleRemoveImage}
                style={{ position: "absolute", top: -6, right: -6, background: "rgba(0,0,0,0.6)", color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
              >✕</button>
            </div>
          )}
        </div>
        {statusMsg && (
          <p className={`status-message ${statusMsg.includes("✅") ? "success" : "error"}`}>{statusMsg}</p>
        )}
        <div className="button-group">
          <button className="btn btn-cancel" onClick={onClose} disabled={isSending}>Cancel</button>
          <button
            className={`btn btn-primary ${isSending || !email.trim() || !message.trim() ? "btn-disabled" : ""}`}
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
