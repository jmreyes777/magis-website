// initSession.js
export const getSessionIds = () => {
  if (!window.name || !window.name.startsWith("sessionTabId-")) {
    window.name = `sessionTabId-${crypto.randomUUID()}`;
  }
  const sessionTabId = window.name;

  let tabId = localStorage.getItem("tabId");
  if (!tabId) {
    tabId = `tabId-${crypto.randomUUID()}`;
    localStorage.setItem("tabId", tabId);
  }

  return { sessionTabId, tabId };
};

// Optional helper to expose sessionTabId for use elsewhere
export const getSessionTabId = () => {
  return window.name;
};
