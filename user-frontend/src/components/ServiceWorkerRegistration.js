// src/components/ServiceWorkerRegistration.js
import { useEffect } from 'react';
import { initTokenManager, setFallbackToken, setCsrfToken } from '../utils/tokenManager.js';
import { fetchCsrfToken } from '../utils/csrf.js';

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Register the service worker at root scope
      navigator.serviceWorker.register('/sw.js').then(registration => {
        console.log('[SW] Service Worker registered:', registration);

        // If there's already a controlling SW, initialize tokens
        if (navigator.serviceWorker.controller) {
          initTokenManager();
        }

        // Listen for when the SW takes control
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          console.log('[SW] Controller changed — reinitializing tokens');
          initTokenManager();
        });
      }).catch(err => {
        console.error('[SW] Service Worker registration failed:', err);
      });

      // Listen for messages from the SW (if any future ones are sent)
      navigator.serviceWorker.addEventListener('message', event => {
        const { type, token } = event.data || {};
        switch (type) {
          case 'UPDATE_FALLBACK_TOKEN':
            setFallbackToken(token);
            break;
          case 'UPDATE_CSRF_TOKEN':
            setCsrfToken(token);
            break;
          default:
            // ignore
        }
      });

      // On mount, fetch a fresh CSRF token to bootstrap
      fetchCsrfToken().then(token => {
        if (token) console.log('[SW] CSRF token fetched and stored');
      });
    }
  }, []);

  return null;
}
