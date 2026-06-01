//magis-project/admin-frontend/src/components/Message-Item-Component.js

import React from 'react';
import PropTypes from 'prop-types';
import './MessageItem.css'; // Ensure corresponding CSS styles are included

const MessageItem = ({ message, sender }) => {
  const isGuest = sender === 'guest'; // Determine if the sender is a guest

  return (
    <div
      className={`message-item ${isGuest ? 'guest' : 'branch'}`}
      title={`Sent at: ${new Date(message.timestamp).toLocaleString()}`} // Tooltip with timestamp
    >
      {/* Render Message Content */}
      <div className="message-content">
        {message.content && (
          <p className="message-text">
            {message.content}
          </p>
        )}

        {/* Render Media (Image or File Attachment) */}
        {message.media && (
          <div className="media-content">
            {message.media.type === 'image' ? (
              <img
                src={message.media.url}
                alt="Image Attachment"
                className="attachment-image"
                loading="lazy" // Enhance performance by lazy-loading images
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
      </div>

      {/* Render Timestamp (Visible, Not Just Tooltip) */}
      <div className="message-timestamp">
        {new Date(message.timestamp).toLocaleString()}
      </div>
    </div>
  );
};

MessageItem.propTypes = {
  message: PropTypes.shape({
    content: PropTypes.string, // Optional for media-only messages
    timestamp: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)])
      .isRequired, // Timestamp is required
    media: PropTypes.shape({
      url: PropTypes.string.isRequired, // URL for the media file
      type: PropTypes.oneOf(['image', 'file']).isRequired, // Media type (e.g., image or file)
    }),
  }).isRequired,
  sender: PropTypes.oneOf(['guest', 'branch']).isRequired, // Sender must be 'guest' or 'branch'
};

export default MessageItem;