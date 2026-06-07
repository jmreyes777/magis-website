// src/Shared/Message-Item-Component.js

import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import "./MessageItem.css";
import { resolveGuestMedia } from "./mediaResolver";

// Defense-in-depth: never render a raw encrypted payload. If decryption failed
// upstream, the content may still be a {"ciphertext":...,"iv":...} blob — show
// a friendly placeholder instead of leaking ciphertext to the screen. We parse
// + verify the shape so a plaintext message that merely mentions "ciphertext"
// is left untouched.
const looksLikeCiphertext = (t) => {
  if (typeof t !== "string") return false;
  const s = t.trim();
  if (s[0] !== "{" || s[s.length - 1] !== "}") return false;
  if (!s.includes('"ciphertext"') || !s.includes('"iv"')) return false;
  try {
    const o = JSON.parse(s);
    return !!o && typeof o.ciphertext === "string" && typeof o.iv === "string";
  } catch {
    return false;
  }
};
const toDisplayText = (t) => (looksLikeCiphertext(t) ? "[Encrypted message]" : t);

const MessageItem = ({ message, sender, hideMedia = false, isLatest }) => {
  const isGuest = sender === "guest";
  const isUnsent = message.status === "failed" || message.pendingRetry;

  // Format timestamp: "May 08, 2025, 05:24 PM"
  const ts = new Date(message.timestamp);
  const formattedTime = ts.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  // Determine seen status - only show for latest message
  const isSeenByAdmin = message.seenByAdmin === true;
  const showSeenIndicator = isLatest && sender === "guest" && isSeenByAdmin;

  // Derive media (P1-3): new uploads are PRIVATE and carry a storage `path`,
  // resolved to a short-lived signed URL via the backend. Legacy docs with a
  // full http(s) URL — and optimistic blob:/data: previews — are used directly.
  const media = message.media || null;
  const directUrl =
    media && typeof media.url === "string" && /^(https?:|blob:|data:)/i.test(media.url)
      ? media.url
      : null;
  const directSrc =
    media && typeof media.src === "string" && /^(https?:|blob:|data:)/i.test(media.src)
      ? media.src
      : null;
  const needsResolve = !!(media && media.path && !directUrl && !directSrc);

  const [resolved, setResolved] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (needsResolve && message.id) {
      resolveGuestMedia(message.id)
        .then((d) => { if (!cancelled) setResolved(d); })
        .catch(() => { if (!cancelled) setResolved(null); });
    } else {
      setResolved(null);
    }
    return () => { cancelled = true; };
  }, [needsResolve, message.id]);

  const mediaType = media ? media.type : null;
  const mediaUrl = directUrl || directSrc || resolved?.url || resolved?.src || null;
  const mediaSrc = directSrc || directUrl || resolved?.src || resolved?.url || null;
  const mediaResolving = needsResolve && !mediaUrl;

  return (
    <div
      className={`message-item ${isGuest ? "guest" : "branch"}`}
      title={`Sent at: ${formattedTime}`}
      style={{ position: "relative", paddingBottom: isGuest ? "0.25rem" : undefined }}
    >
      <div className="message-content">
        {/* Text */}
        {message.message && <p className="message-text">{toDisplayText(message.message)}</p>}

        {/* Media thumbnail + link (P1-3: private media resolved to signed URL) */}
        {mediaType && !hideMedia && (mediaUrl || mediaResolving) && (
          <div className="media-content">
            {mediaResolving ? (
              <span
                className="attachment-loading"
                style={{ fontSize: "0.8rem", color: "#888", fontStyle: "italic" }}
              >
                Loading attachment…
              </span>
            ) : mediaType.startsWith("image") ? (
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

      {/* Seen Indicator - only on latest message, outside message bubble */}
      {showSeenIndicator && (
        <div
          className="seen-indicator"
          style={{
            fontSize: "0.75rem",
            color: "#4CAF50",
            fontWeight: "bold",
            marginTop: "4px",
            textAlign: isGuest ? "right" : "left",
          }}
        >
          Seen by staff
        </div>
      )}
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
  isLatest: PropTypes.bool,
};

export default MessageItem;
