// src/Shared/Message-Item-Component.js

import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import "./MessageItem.css";
import { resolveGuestMedia, invalidateGuestMedia } from "./mediaResolver";

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

// Backoff schedule for media resolve retries. Module-level const so the
// default prop keeps a stable identity across renders. Tests inject [0,0,0]
// to exercise the retry ladder without fake timers.
const DEFAULT_MEDIA_RETRY_DELAYS_MS = [1000, 3000, 8000];

const MessageItem = ({ message, sender, hideMedia = false, isLatest, retryDelaysMs = DEFAULT_MEDIA_RETRY_DELAYS_MS }) => {
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

  // Resolve with bounded retries (1s/3s/8s backoff) so a transient failure —
  // token refresh in flight, network blip, replica lag on a just-written doc —
  // heals itself instead of leaving "Loading attachment…" on screen forever.
  // After the retry budget, we show an explicit tap-to-retry state.
  const [resolved, setResolved] = useState(null);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (!needsResolve || !message.id) {
      setResolved(null);
      setResolveFailed(false);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const delays = retryDelaysMs;
    const attempt = (n) => {
      resolveGuestMedia(message.id)
        .then((d) => {
          if (cancelled) return;
          setResolved(d);
          setResolveFailed(false);
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn(
            `[MEDIA] resolve failed for ${message.id} (attempt ${n + 1}):`,
            err?.message
          );
          if (n < delays.length) {
            timer = setTimeout(() => attempt(n + 1), delays[n]);
          } else {
            setResolveFailed(true);
          }
        });
    };
    setResolveFailed(false);
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [needsResolve, message.id, retryNonce, retryDelaysMs]);

  const retryResolve = () => {
    invalidateGuestMedia(message.id);
    setRetryNonce((n) => n + 1);
  };

  // A signed URL expires ~15 min after minting: if the <img> errors on a
  // long-open chat, refetch once with a fresh signature instead of showing a
  // broken thumbnail.
  const handleImgError = () => {
    invalidateGuestMedia(message.id);
    setResolved(null);
    setRetryNonce((n) => n + 1);
  };

  const mediaType = media ? media.type : null;
  const mediaUrl = directUrl || directSrc || resolved?.url || resolved?.src || null;
  const mediaSrc = directSrc || directUrl || resolved?.src || resolved?.url || null;
  const mediaResolving = needsResolve && !mediaUrl && !resolveFailed;
  const mediaFailed = needsResolve && !mediaUrl && resolveFailed;

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
        {mediaType && !hideMedia && (mediaUrl || mediaResolving || mediaFailed) && (
          <div className="media-content">
            {mediaResolving ? (
              <span
                className="attachment-loading"
                style={{ fontSize: "0.8rem", color: "#888", fontStyle: "italic" }}
              >
                Loading attachment…
              </span>
            ) : mediaFailed ? (
              <button
                type="button"
                onClick={retryResolve}
                className="attachment-retry"
                style={{
                  fontSize: "0.8rem",
                  color: "#b91c1c",
                  background: "none",
                  border: "1px dashed #b91c1c",
                  borderRadius: 6,
                  padding: "4px 8px",
                  cursor: "pointer",
                }}
              >
                ⚠ Attachment unavailable — tap to retry
              </button>
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
                  onError={handleImgError}
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
