// src/Shared/Message-Item-Component.js

import React from "react";
import PropTypes from "prop-types";
import "./MessageItem.css";

const MessageItem = ({ message, sender, hideMedia = false }) => {
  const isGuest = sender === "guest";
  const isUnsent = message.status === "failed" || message.pendingRetry;

  // Format timestamp: “May 08, 2025, 05:24 PM”
  const ts = new Date(message.timestamp);
  const formattedTime = ts.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  // Derive media URL/src with fallback
  let mediaUrl = null;
  let mediaSrc = null;
  let mediaType = null;
  if (message.media) {
    mediaType = message.media.type;
    mediaUrl = message.media.url || message.media.src || null;
    mediaSrc = message.media.src || message.media.url || null;
  }

  return (
    <div
      className={`message-item ${isGuest ? "guest" : "branch"}`}
      title={`Sent at: ${formattedTime}`}
      style={{ position: "relative", paddingBottom: isGuest ? "0.25rem" : undefined }}
    >
      <div className="message-content">
        {/* Text */}
        {message.message && <p className="message-text">{message.message}</p>}

        {/* Media thumbnail + link */}
        {mediaType && mediaUrl && !hideMedia && (
          <div className="media-content">
            {mediaType.startsWith("image") ? (
              <a
                href={mediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="attachment-thumbnail-container"
              >
                <img
                  src={mediaSrc}
                  alt="Image Attachment"
                  className="attachment-thumbnail"
                  loading="lazy"
                />
                <span className="view-full-overlay">View Full Image</span>
              </a>
            ) : (
              <a
                href={mediaUrl}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="attachment-link"
              >
                Download Attachment
              </a>
            )}
          </div>
        )}

        {/* Guest-only failed/pending UI */}
        {isGuest && isUnsent && (
          <div className="message-status-failed">
            <span>
              {message.status === "failed" ? "❌ Failed to send" : "⏳ Pending…"}
            </span>
            {typeof message.retry === "function" && (
              <button className="retry-button" onClick={message.retry} title="Retry">
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

MessageItem.propTypes = {
  message: PropTypes.shape({
    message: PropTypes.string,
    timestamp: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.instanceOf(Date),
    ]).isRequired,
    media: PropTypes.shape({
      type: PropTypes.string.isRequired, // e.g. "image/png" or "application/pdf"
      url: PropTypes.string,  // full-size link (optional)
      src: PropTypes.string,  // thumbnail src (optional)
    }),
    status: PropTypes.string,
    pendingRetry: PropTypes.bool,
    retry: PropTypes.func,
  }).isRequired,
  sender: PropTypes.oneOf(["guest","branch"]).isRequired,
  hideMedia: PropTypes.bool,
};

export default MessageItem;
