// electron-main.js
const { app, BrowserWindow, powerSaveBlocker, ipcMain, dialog } = require("electron");
const path = require("path");

let mainWindow;
let blockerId;
let isQuitting = false;

// This flag is kept up-to-date by your renderer via ipcRenderer.send('active-chats-updated', boolean)
let hasActiveChatsInRenderer = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // ── use a non-persisted, in-memory partition ──────────────
      partition: "in-memory-test",
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
  });

  // ─── Load from the same HTTP(S) origin as your browser ─────────
  const startURL = process.env.ELECTRON_START_URL ||
    (app.isPackaged
      ? "https://admin.yoursite.com"    // ← replace with your live admin URL
      : "https://localhost:3001");      // ← your React dev server URL

  mainWindow.loadURL(startURL);

  // Acquire OS‐level wake lock
  blockerId = powerSaveBlocker.start("prevent-display-sleep");
  console.log("🪄 Wake lock acquired, id=", blockerId);

  // Intercept the very first close event
  mainWindow.on("close", (e) => {
    if (isQuitting) {
      // second pass: really quit
      return;
    }
    e.preventDefault();

    // synchronous read of our in‐RAM flag
    if (hasActiveChatsInRenderer) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        buttons: ["Close Anyway", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: "Active Chats Open",
        message:
          "You have active chats open. Closing now will lose any unsent messages.\n\nClose anyway?",
      });
      if (choice !== 0) {
        // user chose “Cancel”
        return;
      }
    }

    // either no active chats, or “Close Anyway”
    isQuitting = true;
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
    mainWindow.close();
  });
}

app.whenReady().then(createWindow);

// Listen for renderer updates
ipcMain.on("active-chats-updated", (_, hasActive) => {
  hasActiveChatsInRenderer = hasActive;
});

app.on("window-all-closed", () => {
  if (powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
