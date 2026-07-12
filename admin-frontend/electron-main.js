// electron-main.js
const { app, BrowserWindow, Menu, powerSaveBlocker, powerMonitor, ipcMain, dialog, shell } = require("electron");
const path = require("path");

// ── Phase 4 hardening ────────────────────────────────────────────────────
// Chromium OS-level sandbox for every renderer (the preload only uses
// contextBridge/ipcRenderer, which remain available in sandboxed preloads).
app.enableSandbox();

// Single-instance lock: a second launch focuses the existing window instead of
// spawning a parallel session (duplicate sockets/notifications).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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
      backgroundThrottling: false,
      // Packaged builds get no DevTools (staff machines); dev keeps them.
      devTools: !app.isPackaged,
    },
  });

  // Packaged builds: drop the default menu (File/Edit/View… incl. the
  // DevTools accelerator). Dev keeps the menu + shortcuts untouched.
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  // ─── Load from the same HTTP(S) origin as your browser ─────────
  const startURL = process.env.ELECTRON_START_URL ||
    (app.isPackaged
      ? "https://magis-admin-staging.onrender.com"  // ← admin dashboard (staging; swap when prod URL exists)
      : "http://localhost:3001");       // ← CRA dev server (npm start passes ELECTRON_START_URL anyway)

  mainWindow.loadURL(startURL);

  // A08-1: lock navigation to the app origin and hand external links to the OS
  // browser instead of opening them inside Electron (defense-in-depth alongside
  // contextIsolation:true / nodeIntegration:false).
  const appOrigin = (() => { try { return new URL(startURL).origin; } catch { return null; } })();
  const isSameOrigin = (target) => {
    try { return appOrigin !== null && new URL(target).origin === appOrigin; }
    catch { return false; }
  };
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isSameOrigin(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Acquire OS-level wake lock. "prevent-app-suspension" keeps the SYSTEM (and
  // therefore sockets/timers) awake through inactivity timeouts while still
  // letting the DISPLAY sleep — chat persistence without a screen burning 24/7.
  // (The old "prevent-display-sleep" kept the monitor on permanently.)
  blockerId = powerSaveBlocker.start("prevent-app-suspension");
  console.log("🪄 Wake lock acquired (prevent-app-suspension), id=", blockerId);

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

app.whenReady().then(() => {
  createWindow();

  // Sleep can still happen despite the blocker (lid close, manual sleep, OS
  // power policies). Forward power transitions to the renderer so the chat
  // socket can park cleanly on suspend and revive INSTANTLY on resume instead
  // of waiting for a heartbeat timeout. Handled in Admin-Utils-socket.js via
  // window.electronAPI.onPowerEvent (see preload.js).
  const sendPowerEvent = (event) => {
    console.log(`⚡ powerMonitor: ${event}`);
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send("power-event", { event, at: Date.now() });
      }
    });
  };
  powerMonitor.on("suspend", () => sendPowerEvent("suspend"));
  powerMonitor.on("resume", () => sendPowerEvent("resume"));
  powerMonitor.on("unlock-screen", () => sendPowerEvent("unlock-screen"));
});

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
