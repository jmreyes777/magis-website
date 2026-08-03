/* eslint-disable no-restricted-globals */
// CHATUX3: dedicated push service worker for staff notifications.
//
// Deliberately contains NO fetch handler — it never intercepts requests, so
// it cannot interfere with API calls, socket.io, or static assets. Its only
// jobs: show OS notifications for pushes, and focus/open the chat dashboard
// on click. (public/sw.js is a legacy, unregistered file — this one is
// registered explicitly by src/utils/pushManager.js.)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "New chat message";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "A guest is waiting in the chat dashboard.",
      // tag collapses bursts from the same conversation into one notification
      tag: data.tag || "magis-chat",
      renotify: false,
      icon: "/logo192.png",
      badge: "/logo192.png",
      data: { url: data.url || "/admin/chats" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/admin/chats";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Prefer focusing an already-open dashboard tab over spawning a new one.
        const existing =
          clients.find((c) => c.url.includes("/admin/chats")) ||
          clients.find((c) => c.url.includes("/admin"));
        if (existing) {
          existing.navigate?.(targetUrl);
          return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
