// =========================================================================
// AuraAudio Desktop Application - Electron Main Process (main.js)
// Frameless Transparent Window, 3-State Dynamic Sizing & Embedded REST API Server
// =========================================================================

const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const AuraServer = require('./server/index');

let mainWindow = null;
let auraServerInstance = null;
let serverInfo = { active: false, port: 3456, host: '127.0.0.1', url: 'http://127.0.0.1:3456' };

const SERVER_START_TIMEOUT_MS = 10000;

const WINDOW_STATE_FILE = 'window-state.json';
const FULL_MODE_DEFAULTS = { width: 960, height: 600 };
const REDUCED_MODES = new Set(['micro', 'compact']);
let windowModeState = { mode: 'full', fullBounds: null, reducedBounds: { micro: null, compact: null }, alwaysOnTop: false, userAlwaysOnTop: false };

function windowStatePath() {
  try { return path.join(app.getPath('userData'), WINDOW_STATE_FILE); }
  catch { return null; }
}

function loadWindowModeState() {
  const file = windowStatePath();
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object') {
      const userAlwaysOnTop = Boolean(data.userAlwaysOnTop ?? data.alwaysOnTop);
      windowModeState = {
        mode: typeof data.mode === 'string' ? data.mode : 'full',
        fullBounds: data.fullBounds && typeof data.fullBounds === 'object' ? data.fullBounds : null,
        reducedBounds: data.reducedBounds && typeof data.reducedBounds === 'object' ? data.reducedBounds : { micro: null, compact: null },
        alwaysOnTop: userAlwaysOnTop,
        userAlwaysOnTop
      };
    }
  } catch (err) {
    console.warn('[Main] Could not load window state:', err.message);
  }
}

function saveWindowModeState() {
  const file = windowStatePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(windowModeState), 'utf8');
  } catch (err) {
    console.warn('[Main] Could not save window state:', err.message);
  }
}

function effectiveAlwaysOnTop(mode = windowModeState.mode) {
  // Reduced/pinned states (micro/compact) should float above other apps, including
  // borderless-fullscreen games where possible. Full mode respects the user toggle.
  return Boolean(windowModeState.userAlwaysOnTop || REDUCED_MODES.has(mode));
}

function applyAlwaysOnTop(mode = windowModeState.mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const enabled = effectiveAlwaysOnTop(mode);
  windowModeState.alwaysOnTop = enabled;
  mainWindow.setAlwaysOnTop(enabled, alwaysOnTopLevel(enabled));
  if (enabled && typeof mainWindow.moveTop === 'function') {
    try { mainWindow.moveTop(); } catch (_) {}
  }
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
}

function captureCurrentBounds(mode) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
  const bounds = mainWindow.getBounds();
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
  const snapshot = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  if (mode === 'full') windowModeState.fullBounds = snapshot;
  else if (REDUCED_MODES.has(mode)) {
    windowModeState.reducedBounds = windowModeState.reducedBounds || {};
    windowModeState.reducedBounds[mode] = snapshot;
  }
}

function ensureBoundsVisible(bounds, { minWidth = 300, minHeight = 52 } = {}) {
  const displays = screen.getAllDisplays();
  if (!displays.length) return bounds;
  const workAreas = displays.map(display => display.workArea).filter(Boolean);
  const width = Math.max(minWidth, Math.min(Math.round(bounds.width || minWidth), Math.max(...workAreas.map(area => area.width))));
  const height = Math.max(minHeight, Math.min(Math.round(bounds.height || minHeight), Math.max(...workAreas.map(area => area.height))));
  let x = Math.round(Number.isFinite(bounds.x) ? bounds.x : workAreas[0].x);
  let y = Math.round(Number.isFinite(bounds.y) ? bounds.y : workAreas[0].y);
  const visible = workAreas.some(area => x < area.x + area.width - 40 && x + width > area.x + 40 && y < area.y + area.height - 40 && y + height > area.y + 40);
  if (!visible) {
    const area = screen.getDisplayNearestPoint({ x, y }).workArea || workAreas[0];
    x = Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - width));
    y = Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - height));
  } else {
    // Clamp so at least part stays reachable, prefer keeping fully on nearest display.
    const area = screen.getDisplayMatching({ x, y, width, height }).workArea || workAreas[0];
    x = Math.min(Math.max(x, area.x - width + 80), area.x + area.width - 80);
    y = Math.min(Math.max(y, area.y), area.y + area.height - 48);
  }
  return { x, y, width, height };
}

function alwaysOnTopLevel(enabled) {
  if (!enabled) return 'normal';
  // League of Legends and other fullscreen games can obscure "floating"; use a
  // higher level on Windows while keeping a safer default elsewhere.
  return process.platform === 'win32' ? 'screen-saver' : 'floating';
}

async function initEmbeddedServer() {
  try {
    auraServerInstance = new AuraServer(app.isPackaged ? { storageRoot: app.getPath('userData') } : {});
    const info = await Promise.race([
      auraServerInstance.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Embedded server start timed out')), SERVER_START_TIMEOUT_MS))
    ]);
    serverInfo = {
      active: true,
      port: info.port,
      host: info.host,
      url: info.url
    };
    console.log(`[Main] AuraAudio API Server online: ${serverInfo.url}`);
  } catch (err) {
    console.error('[Main] Failed to start embedded server:', err.message);
  }
}

function createWindow() {
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'royal-blue', 'x.ico')
    : path.join(__dirname, 'assets', 'icon.png');

  const restoredFull = ensureBoundsVisible({
    ...FULL_MODE_DEFAULTS,
    ...(windowModeState.fullBounds || {})
  }, { minWidth: 720, minHeight: 480 });

  mainWindow = new BrowserWindow({
    x: restoredFull.x,
    y: restoredFull.y,
    width: restoredFull.width,
    height: restoredFull.height,
    minWidth: 300,
    minHeight: 52,
    frame: false, // Frameless transparent window
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      // Keep Web Audio running when the window is reduced or temporarily occluded.
      backgroundThrottling: false
    }
  });

  windowModeState.mode = 'full';
  applyAlwaysOnTop('full');

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Forward window state events to renderer
  mainWindow.on('blur', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-blur');
    }
  });

  mainWindow.on('focus', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-focus');
    }
  });

  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state-changed', { isMaximized: true });
    }
  });

  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state-changed', { isMaximized: false });
    }
  });

  let saveBoundsTimer = null;
  const scheduleSaveBounds = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null;
      if (windowModeState.mode === 'full') {
        captureCurrentBounds('full');
        saveWindowModeState();
      }
    }, 250);
  };

  mainWindow.on('resize', () => {
    if (!mainWindow.isDestroyed()) {
      const [width, height] = mainWindow.getSize();
      mainWindow.webContents.send('window-resized', { width, height });
      scheduleSaveBounds();
    }
  });

  mainWindow.on('move', scheduleSaveBounds);
  mainWindow.on('close', () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    if (windowModeState.mode === 'full') captureCurrentBounds('full');
    saveWindowModeState();
  });
}

// -------------------------------------------------------------
// IPC HANDLERS SETUP
// -------------------------------------------------------------
function setupIpcHandlers() {
  // WINDOW MANAGEMENT
  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.on('window-maximize-toggle', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  // Update the native Windows taskbar/window icon when the user changes theme.
  ipcMain.on('window-set-palette', (event, palette) => {
    const allowedPalettes = new Set(['royal-blue', 'spotify-green', 'cyber-violet', 'vibrant-amber', 'hot-pink']);
    if (!allowedPalettes.has(palette) || !mainWindow || mainWindow.isDestroyed()) return;

    const paletteIcon = path.join(__dirname, 'assets', palette, 'x.ico');
    if (require('fs').existsSync(paletteIcon)) mainWindow.setIcon(paletteIcon);
  });

  ipcMain.on('window-set-mode', (event, mode) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!['micro', 'compact', 'full'].includes(mode)) return;

    const previousMode = windowModeState.mode || 'full';
    if (previousMode === mode) {
      event.sender.send('window-mode-changed', mode);
      return;
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    }

    // Persist the geometry of the mode we're leaving so "reopen"/restore uses
    // the last position the user chose (including state-3/micro moved down-screen).
    captureCurrentBounds(previousMode);

    if (mode === 'micro') {
      windowModeState.mode = 'micro';
      mainWindow.setMinimumSize(300, 52);
      mainWindow.setHasShadow(false);
      const saved = windowModeState.reducedBounds?.micro;
      const next = ensureBoundsVisible(saved || { x: mainWindow.getBounds().x, y: mainWindow.getBounds().y, width: 380, height: 58 }, { minWidth: 300, minHeight: 52 });
      mainWindow.setBounds(next, true);
    } else if (mode === 'compact') {
      windowModeState.mode = 'compact';
      mainWindow.setMinimumSize(460, 180);
      mainWindow.setHasShadow(true);
      const saved = windowModeState.reducedBounds?.compact;
      const next = ensureBoundsVisible(saved || { x: mainWindow.getBounds().x, y: mainWindow.getBounds().y, width: 520, height: 220 }, { minWidth: 460, minHeight: 180 });
      mainWindow.setBounds(next, true);
    } else {
      // 'full' - restore cached full location/size and guarantee it is not cropped
      // under/off the screen after being reduced near a screen edge.
      windowModeState.mode = 'full';
      mainWindow.setMinimumSize(720, 480);
      mainWindow.setHasShadow(true);
      const saved = windowModeState.fullBounds || { ...FULL_MODE_DEFAULTS };
      const next = ensureBoundsVisible(saved, { minWidth: 720, minHeight: 480 });
      mainWindow.setBounds(next, true);
      windowModeState.fullBounds = next;
    }

    applyAlwaysOnTop(mode);
    saveWindowModeState();
    event.sender.send('window-mode-changed', mode);
    event.sender.send('window-always-on-top-changed', effectiveAlwaysOnTop(mode));
  });

  ipcMain.on('window-set-size', (event, { width, height }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setMinimumSize(Math.min(width, 300), Math.min(height, 52));
    mainWindow.setSize(width, height, true);
  });

  ipcMain.on('window-set-always-on-top', (event, flag) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    windowModeState.userAlwaysOnTop = Boolean(flag);
    applyAlwaysOnTop(windowModeState.mode);
    saveWindowModeState();
    event.sender.send('window-always-on-top-changed', effectiveAlwaysOnTop(windowModeState.mode));
  });

  ipcMain.handle('window-get-state', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { isMaximized: false, isAlwaysOnTop: false, width: 960, height: 600, mode: windowModeState.mode || 'full' };
    }
    const [width, height] = mainWindow.getSize();
    return {
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: effectiveAlwaysOnTop(windowModeState.mode),
      mode: windowModeState.mode || 'full',
      width,
      height
    };
  });

  // SERVER & OS SYSTEM INTEGRATION
  ipcMain.handle('server-get-info', () => {
    return serverInfo;
  });

  ipcMain.on('shell-open-external', (event, targetUrl) => {
    if (targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      shell.openExternal(targetUrl);
    }
  });

  ipcMain.on('library-open-downloads-folder', () => {
    const downloadsPath = auraServerInstance?.downloadsDir || path.resolve(__dirname, 'downloads');
    shell.openPath(downloadsPath);
  });
}

// -------------------------------------------------------------
// APP LIFECYCLE
// -------------------------------------------------------------
app.whenReady().then(async () => {
  loadWindowModeState();
  setupIpcHandlers();
  await initEmbeddedServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', async () => {
  if (auraServerInstance) {
    try {
      await auraServerInstance.stop();
    } catch (e) {
      console.warn('[Main] Server shutdown warning:', e.message);
    }
  }
});
