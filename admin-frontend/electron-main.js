// electron-main.js
const { app, BrowserWindow, Menu, powerSaveBlocker, powerMonitor, ipcMain, dialog, shell } = require("electron");
const path = require("path");

// ── Phase 4 hardening ────────────────────────────────────────────────────
// Chromium OS-level sandbox for every renderer (the preload only uses
// contextBridge/ipcRenderer, which remain available in sandboxed preloads).
app.enableSandbox();

// Windows toast notifications + taskbar grouping need an explicit app
// identity that matches electron-builder's appId (package.json → build.appId);
// without it, packaged builds show notifications as "electron.app.Electron"
// or not at all.
app.setAppUserModelId("com.magisgold.admin");

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
      // Packaged (installed) builds keep a PERSISTENT profile so staff
      // sessions and the 30-day "remember this device" OTP trust survive
      // app restarts — otherwise every launch demands a fresh email code.
      // Dev keeps the throwaway in-memory partition (clean state per run).
      partition: app.isPackaged ? "persist:magis-admin" : "in-memory-test",
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
      ? "https://magis-admin-staging.onrender.com"  // ← hosted admin dashboard (update here when the URL moves)
      : "http://localhost:3001");       // ← CRA dev server (npm start passes ELECTRON_START_URL anyway)

  mainWindow.loadURL(startURL);

  // Cold start / offline resilience: Render can 502 or stall for ~30s while
  // the dyno wakes, and branch connections drop. Instead of a dead white
  // window, show a branded "connecting" splash and retry until it loads.
  // errorCode -3 (ERR_ABORTED) is a cancelled navigation, not a failure.
  const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
    <html><head><meta charset="utf-8"><title>Magis Admin</title></head>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                 background:#1f2233;font-family:Segoe UI,system-ui,sans-serif;color:#fff">
      <div style="text-align:center">
        <div style="width:64px;height:64px;margin:0 auto 18px;border-radius:50%;
                    border:3px solid rgba(242,193,20,.25);border-top-color:#f2c114;
                    animation:spin 1s linear infinite"></div>
        <div style="font-size:1.05rem;font-weight:600;letter-spacing:.02em">Connecting to Magis Admin…</div>
        <div style="margin-top:8px;font-size:.8rem;color:rgba(255,255,255,.55)">
          Retrying automatically — check the branch internet if this persists.</div>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </body></html>`)}`;
  let retryTimer = null;
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    console.warn(`⚠ load failed (${errorCode} ${errorDesc}) — retrying in 6s`);
    mainWindow.loadURL(SPLASH);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!mainWindow.isDestroyed()) mainWindow.loadURL(startURL);
    }, 6000);
  });
  mainWindow.on("closed", () => clearTimeout(retryTimer));

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
