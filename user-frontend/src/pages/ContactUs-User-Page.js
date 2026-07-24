import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import GuestChatBox from '../components/Guest-Chat-Box-Component'; // Ensure GuestChatBox is imported
import Seo from '../components/Seo';
import { getSocketInstance, connectSocket } from '../Shared/User-Utils-socket';
import { getTurnstileToken, preloadTurnstile } from '../Shared/turnstile';
import './ContactUs-User-Page.css'; // Ensure this file exists

// API base: empty in dev (CRA proxy handles /api), absolute in production.
const API_BASE =
  (process.env.REACT_APP_API_URL &&
    process.env.REACT_APP_API_URL.replace(/\/$/, '')) ||
  '';

// "Chat with Support" routes to a real, staff-monitored branch inbox. Override
// via REACT_APP_SUPPORT_BRANCH_EMAIL; the value MUST exist in `branchAdmins`
// (with staff) for the conversation to actually be received.
const SUPPORT_BRANCH_EMAIL =
  process.env.REACT_APP_SUPPORT_BRANCH_EMAIL || 'support@magisgold.com';
const SUPPORT_BRANCH_NAME = 'Support';

const socket = getSocketInstance();

function ContactUs() {
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });
  const [activeChat, setActiveChat] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false); // Loading state for form submission
  const [isStartingChat, setIsStartingChat] = useState(false); // Loading state for chat initiation
  const [error, setError] = useState(null); // Error state
  // UAT F-G4: inline success feedback (replaces the blocking window.alert).
  const [success, setSuccess] = useState(null);
  const successTimer = useRef(null);

  useEffect(() => {
    // Warm up the Turnstile widget so a token is ready on submit / chat start.
    try {
      preloadTurnstile && preloadTurnstile();
    } catch (_) {}
    return () => clearTimeout(successTimer.current);
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      let turnstileToken = null;
      try { turnstileToken = await getTurnstileToken(); } catch (_) {}
      await axios.post(
        `${API_BASE}/api/contact`,
        { ...formData, turnstileToken },
        { withCredentials: true }
      );
      // UAT F-G4: inline banner instead of a blocking alert().
      setSuccess('Thank you for reaching out! We will get back to you soon.');
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSuccess(null), 8000);
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
      // Reuse an existing guest session only if it's already bound to Support;
      // otherwise start a fresh one so messages route to the right inbox.
      const existingBranch = sessionStorage.getItem('branchEmail');
      let guestId =
        sessionStorage.getItem('guestId') || localStorage.getItem('guestId');
      let guestToken =
        sessionStorage.getItem('guestToken') ||
        localStorage.getItem('guestToken');
      const canReuse =
        guestId &&
        guestToken &&
        existingBranch &&
        existingBranch.toLowerCase() === SUPPORT_BRANCH_EMAIL.toLowerCase();

      if (!canReuse) {
        let turnstileToken = null;
        try { turnstileToken = await getTurnstileToken(); } catch (_) {}
        const res = await fetch(`${API_BASE}/api/guest/init`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Support Chat Guest',
            email: `${Date.now()}@guest.local`,
            branchEmail: SUPPORT_BRANCH_EMAIL,
            turnstileToken,
          }),
        });
        if (!res.ok) throw new Error('Guest init failed');
        const data = await res.json();
        guestId = data.guestId;
        guestToken = data.token;
      }

      if (!guestId || !guestToken) {
        throw new Error('Invalid chat session details received.');
      }

      // Persist session + associate the Support branch (chat box + caches read these).
      sessionStorage.setItem('guestId', guestId);
      sessionStorage.setItem('guestToken', guestToken);
      localStorage.setItem('guestId', guestId);
      localStorage.setItem('guestToken', guestToken);
      sessionStorage.setItem('branchEmail', SUPPORT_BRANCH_EMAIL);
      sessionStorage.setItem('branchId', 'support');
      sessionStorage.setItem('chatOpen', 'true');

      // Socket + UI (mirrors the Branches page chat-open flow).
      if (!localStorage.getItem('tabId'))
        localStorage.setItem('tabId', crypto.randomUUID());
      if (!window.name) window.name = crypto.randomUUID();
      if (!socket.connected) connectSocket(guestId);

      setActiveChat({
        branchId: 'support',
        branchEmail: SUPPORT_BRANCH_EMAIL,
        branchName: SUPPORT_BRANCH_NAME,
        schedule: [],
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
        title="Contact Us | Magis Gold & Gems Pawnshop"
        description="Contact Magis Gold & Gems — message us or live-chat about pawning, jewelry, and branch services, including our contact number and customer service."
        path="/contact-us"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Contact Us", path: "/contact-us" },
        ]}
      />
      <div className="contact-card">
        <h1 className="contact-header">Contact Us</h1>
        <p className="contact-subtitle">
          Message us or start a live chat about pawning, jewelry, and branch
          services — we’re happy to help.
        </p>

        {/* Error Message */}
        {error && <p className="error-message">{error}</p>}

        {/* Success Message (inline, auto-dismisses) */}
        {success && (
          <p
            className="success-message text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm"
            role="status"
          >
            {success}
          </p>
        )}

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
          key={`${activeChat.branchId}-${activeChat.guestId}`}
          branchId={activeChat.branchId}
          branchEmail={activeChat.branchEmail}
          branchName={activeChat.branchName}
          schedule={activeChat.schedule || []}
          guestId={activeChat.guestId}
          onClose={() => setActiveChat(null)}
        />
      )}
    </div>
  );
}

export default ContactUs;