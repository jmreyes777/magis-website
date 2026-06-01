// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  sendActiveChatsUpdate: (hasActive) =>
    ipcRenderer.send("active-chats-updated", hasActive),
});
