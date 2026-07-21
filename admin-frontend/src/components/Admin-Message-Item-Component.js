// src/components/Admin-Message-Item-Component.js
import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import './AdminMessageItem.css';
import { resolveAdminMedia, invalidateAdminMedia } from '../utils/mediaResolver';

// Defense-in-depth: never render a raw encrypted payload. If decryption failed
// upstream (e.g. the secure channel wasn't established for this session), the
// content may still be a {"ciphertext":...,"iv":...} blob — show a friendly
// placeholder instead of leaking ciphertext to the screen. We parse + verify
// the shape so a plaintext message that merely mentions "ciphertext" is safe.
const looksLikeCiphertext = (t) => {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (s[0] !== '{' || s[s.length - 1] !== '}') return false;
  if (!s.includes('"ciphertext"') || !s.includes('"iv"')) return false;
  try {
    const o = JSON.parse(s);
    return !!o && typeof o.ciphertext === 'string' && typeof o.iv === 'string';
  } catch {
    return false;
  }
};
const toDisplayText = (t) => (looksLikeCiphertext(t) ? '[Encrypted message]' : t);

// SPD5-3 (speed megaplan): memoized — the dashboard re-renders on EVERY
// keystroke in the reply input (controlled input state lives in the page
// component), which previously re-rendered all N message rows each time. The
// parent updates message arrays immutably (`prev.map` replaces only changed
// items, unchanged rows keep object identity), so React.memo's shallow prop
// compare is exact: a row re-renders only when its message object, sender, or
// isLatest actually changed. No behavior change.
// Backoff schedule for media resolve retries. Module-level const so the
// default prop keeps a stable identity across renders (a fresh array literal
// default would re-trigger the resolve effect every render). Tests inject
// [0,0,0] to exercise the retry ladder without fake timers.
const DEFAULT_MEDIA_RETRY_DELAYS_MS = [1000, 3000, 8000];

const AdminMessageItem = React.memo(({ message, sender, isLatest, retryDelaysMs = DEFAULT_MEDIA_RETRY_DELAYS_MS }) => {
  const isUnsent = message.status === 'failed' || message.pendingRetry;
  // Format timestamp as "MMM DD, YYYY at hh:mm AM/PM"
  const ts = new Date(message.timestamp);
  const formattedTime = ts.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  // Determine seen status - only show "Seen by guest" on admin's latest message
  const isSeenByGuest = message.seenByGuest === true;
  const showSeenIndicator = isLatest && sender === 'branch' && isSeenByGuest;

  // Media (P1-3): new uploads are PRIVATE and carry a storage `path`, resolved
  // to a short-lived signed URL via the backend. Legacy docs with a full http(s)
  // URL — and optimistic blob:/data: previews — are used directly.
  const media = message.media || null;
  const directUrl =
    media && typeof media.url === 'string' && /^(https?:|blob:|data:)/i.test(media.url)
      ? media.url
      : null;
  const directSrc =
    media && typeof media.src === 'string' && /^(https?:|blob:|data:)/i.test(media.src)
      ? media.src
      : null;
  const needsResolve = !!(media && media.path && !directUrl && !directSrc);

  // Resolve with bounded retries (1s/3s/8s backoff), then an explicit
  // tap-to-retry state — a transient failure must never leave the eternal
  // "Loading attachment…" label (see the branch→guest 3.75MB incident).
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
      resolveAdminMedia(message.id)
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
    invalidateAdminMedia(message.id);
    setRetryNonce((n) => n + 1);
  };

  // Signed URLs expire ~15 min after minting; on <img> error refetch with a
  // fresh signature instead of leaving a broken thumbnail in a long-open tab.
  const handleImgError = () => {
    invalidateAdminMedia(message.id);
    setResolved(null);
    setRetryNonce((n) => n + 1);
  };

  const mediaType = media ? media.type : null;
  const mediaUrl = directUrl || directSrc || resolved?.url || resolved?.src || null;
  const mediaSrc = directSrc || directUrl || resolved?.src || resolved?.url || null;
  const mediaSrcSet = (directSrc || directUrl) ? media.srcSet : resolved?.srcSet;
  const mediaResolving = needsResolve && !mediaUrl && !resolveFailed;
  const mediaFailed = needsResolve && !mediaUrl && resolveFailed;

  return (
    <div
      className={`admin-message-item ${sender === 'branch' ? 'branch' : 'guest'}`}
      title={`Sent at: ${ts.toLocaleString()}`}
      style={{ position: 'relative', paddingBottom: '1.25rem' }}
    >
      <div className="message-content">
        {/* Text Content */}
        <p className="message-text">
          {toDisplayText(message.message || message.content) || "[No message]"}
        </p>

        {/* Media Content (P1-3: private media resolved to signed URL) */}
        {mediaType && (mediaUrl || mediaResolving || mediaFailed) && (
          <div className="media-content">
            {mediaResolving ? (
              <span
                className="attachment-loading"
                style={{ fontSize: '0.8rem', color: '#888', fontStyle: 'italic' }}
              >
                Loading attachment…
              </span>
            ) : mediaFailed ? (
              <button
                type="button"
                onClick={retryResolve}
                className="attachment-retry"
                style={{
                  fontSize: '0.8rem',
                  color: '#b91c1c',
                  background: 'none',
                  border: '1px dashed #b91c1c',
                  borderRadius: 6,
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                ⚠ Attachment unavailable — tap to retry
              </button>
            ) : mediaType === 'image' ? (
              <img
                src={mediaSrc || mediaUrl}
                srcSet={mediaSrcSet}
                sizes="(max-width: 600px) 100vw, 600px"
                alt="Image Attachment"
                className="attachment-image"
                loading="lazy"
                onError={handleImgError}
              />
            ) : (
              <a
                href={mediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="attachment-link"
                title="Click to view file"
              >
                View File Attachment
              </a>
            )}
          </div>
        )}

        {/* Failed / Pending Status for Branch */}
        {isUnsent && sender === 'branch' && (
          <div className="message-status-failed">
            <span>
              {message.status === 'failed'
                ? '❌ Failed to send'
                : '⏳ Pending confirmation'}
            </span>
            {typeof message.retry === 'function' && (
              <button
                className="retry-button"
                onClick={message.retry}
                title="Retry sending this message"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {/* Timestamp inside bubble */}
        <div
          className="message-timestamp"
          style={{
            position: 'absolute',
            bottom: '4px',
            right: '8px',
            fontSize: '0.50em',
            fontStyle: 'italic',
            // Staff replies sit on the dark navy bubble — gray was illegible.
            color: sender === 'branch' ? 'rgba(255, 255, 255, 0.9)' : '#666',
          }}
        >
          {formattedTime}
        </div>

        {/* Seen Indicator - only on latest admin message */}
        {showSeenIndicator && (
          <div
            className="seen-indicator"
            style={{
              position: 'absolute',
              bottom: '4px',
              left: '8px',
              fontSize: '0.50em',
              color: '#4CAF50',
              fontWeight: 'bold',
            }}
          >
            Seen by guest
          </div>
        )}
      </div>
    </div>
  );
});

AdminMessageItem.displayName = 'AdminMessageItem';

AdminMessageItem.propTypes = {
  message: PropTypes.shape({
    message: PropTypes.string,
    content: PropTypes.string,
    timestamp: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.instanceOf(Date)
    ]).isRequired,
    media: PropTypes.shape({
      url: PropTypes.string,
      path: PropTypes.string,
      type: PropTypes.oneOf(['image', 'file']).isRequired,
      src: PropTypes.string,
      srcSet: PropTypes.string,
      name: PropTypes.string,
    }),
    status: PropTypes.string,
    pendingRetry: PropTypes.bool,
    retry: PropTypes.func,
  }).isRequired,
  sender: PropTypes.oneOf(['branch', 'guest']).isRequired,
  isLatest: PropTypes.bool,
};

export default AdminMessageItem;
