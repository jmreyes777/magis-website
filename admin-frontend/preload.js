// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  sendActiveChatsUpdate: (hasActive) =>
    ipcRenderer.send("active-chats-updated", hasActive),

  // OS power transitions (suspend / resume / unlock-screen) forwarded from
  // electron-main.js. Consumed by Admin-Utils-socket.js to park the chat
  // socket on sleep and revive it instantly on wake. Returns an unsubscribe.
  onPowerEvent: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("power-event", listener);
    return () => ipcRenderer.removeListener("power-event", listener);
  },
});
