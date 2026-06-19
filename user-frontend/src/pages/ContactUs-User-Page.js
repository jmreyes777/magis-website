import React, { useState } from 'react';
import axios from 'axios';
import GuestChatBox from '../components/Guest-Chat-Box-Component'; // Ensure GuestChatBox is imported
import Seo from '../components/Seo';
import './ContactUs-User-Page.css'; // Ensure this file exists

function ContactUs() {
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });
  const [activeChat, setActiveChat] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false); // Loading state for form submission
  const [isStartingChat, setIsStartingChat] = useState(false); // Loading state for chat initiation
  const [error, setError] = useState(null); // Error state

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await axios.post('http://localhost:5000/api/contact', formData); // Adjust API endpoint as needed
      alert('Thank you for reaching out! We will get back to you soon.');
      setFormData({ name: '', email: '', message: '' }); // Clear the form
    } catch (error) {
      console.error('Error submitting form:', error.message);
      setError('Failed to send your message. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChatWithSupport = async () => {
    setIsStartingChat(true);
    setError(null);

    try {
      const response = await axios.post('http://localhost:5000/api/chat/create-space', {
        branchEmail: 'support@magisgold.com', // Replace with your support email
        branchName: 'Support',
      });

      const { spaceId, guestId } = response.data;
      if (!spaceId || !guestId) {
        throw new Error('Invalid chat session details received.');
      }

      setActiveChat({
        branchName: 'Support',
        spaceId,
        guestId,
      });
    } catch (error) {
      console.error('Error starting chat:', error.message);
      setError('Failed to start chat. Please try again.');
    } finally {
      setIsStartingChat(false);
    }
  };

  return (
    <div className="contact-page">
      <Seo
        title="Contact Us | Magis Gold & Gem Pawnshop"
        description="Get in touch with Magis Gold & Gem — send a message or chat with support about pawning, jewelry sales, and branch services."
        path="/contact-us"
      />
      <div className="contact-card">
        <h1 className="contact-header">Contact Us</h1>

        {/* Error Message */}
        {error && <p className="error-message">{error}</p>}

        <form onSubmit={handleSubmit} className="contact-form">
          <div className="form-group">
            <label htmlFor="name">Name</label>
            <input
              type="text"
              name="name"
              id="name"
              placeholder="Your Name"
              value={formData.name}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              name="email"
              id="email"
              placeholder="Your Email"
              value={formData.email}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="message">Message</label>
            <textarea
              name="message"
              id="message"
              placeholder="Your Message"
              value={formData.message}
              onChange={handleChange}
              required
            />
          </div>

          <button
            type="submit"
            className="submit-button"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Sending...' : 'Send Message'}
          </button>
        </form>

        {/* Chat Button */}
        <div className="mt-4">
          <button
            onClick={handleChatWithSupport}
            className={`chat-button ${isStartingChat ? 'disabled' : ''}`}
            disabled={isStartingChat}
            aria-label="Start chat with support"
          >
            {isStartingChat ? 'Starting Chat...' : 'Chat with Support'}
          </button>
        </div>
      </div>

      {/* Guest Chat Box */}
      {activeChat && (
        <GuestChatBox
          branchName={activeChat.branchName}
          spaceId={activeChat.spaceId}
          guestId={activeChat.guestId}
          onClose={() => setActiveChat(null)}
        />
      )}
    </div>
  );
}

export default ContactUs;