// src/components/Admin-Message-Item-Component.js
import React from 'react';
import PropTypes from 'prop-types';
import './AdminMessageItem.css';

const AdminMessageItem = ({ message, sender, isLatest }) => {
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

  return (
    <div
      className={`admin-message-item ${sender === 'branch' ? 'branch' : 'guest'}`}
      title={`Sent at: ${ts.toLocaleString()}`}
      style={{ position: 'relative', paddingBottom: '1.25rem' }}
    >
      <div className="message-content">
        {/* Text Content */}
        <p className="message-text">
          {message.message || message.content || "[No message]"}
        </p>

        {/* Media Content */}
        {message.media && (
          <div className="media-content">
            {message.media.type === 'image' ? (
              <img
                src={message.media.src || message.media.url}
                srcSet={message.media.srcSet}
                sizes="(max-width: 600px) 100vw, 600px"
                alt="Image Attachment"
                className="attachment-image"
                loading="lazy"
              />
            ) : (
              <a
                href={message.media.url}
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
            color: '#666',
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
};

AdminMessageItem.propTypes = {
  message: PropTypes.shape({
    message: PropTypes.string,
    content: PropTypes.string,
    timestamp: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.instanceOf(Date)
    ]).isRequired,
    media: PropTypes.shape({
      url: PropTypes.string.isRequired,
      type: PropTypes.oneOf(['image', 'file']).isRequired,
      src: PropTypes.string,
      srcSet: PropTypes.string,
    }),
    status: PropTypes.string,
    pendingRetry: PropTypes.bool,
    retry: PropTypes.func,
  }).isRequired,
  sender: PropTypes.oneOf(['branch', 'guest']).isRequired,
  isLatest: PropTypes.bool,
};

export default AdminMessageItem;
