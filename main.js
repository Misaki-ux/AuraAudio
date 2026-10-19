// =========================================================================
// AuraAudio Desktop Application - Electron Main Process (main.js)
// Frameless Transparent Window, 3-State Dynamic Sizing & Embedded REST API Server
// =========================================================================

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const AuraServer = require('./server/index');

let mainWindow = null;
let auraServerInstance = null;
let serverInfo = { active: false, port: 3456, host: '127.0.0.1', url: 'http://127.0.0.1:3456' };

async function initEmbeddedServer() {
  try {
    auraServerInstance = new AuraServer(app.isPackaged ? { storageRoot: app.getPath('userData') } : {});
    const info = await auraServerInstance.start();
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

  mainWindow = new BrowserWindow({
    width: 960,
    height: 600,
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
      webSecurity: false
    }
  });

  mainWindow.loadFile('index.html');

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

  mainWindow.on('resize', () => {
    if (!mainWindow.isDestroyed()) {
      const [width, height] = mainWindow.getSize();
      mainWindow.webContents.send('window-resized', { width, height });
    }
  });
}

// -------------------------------------------------------------
// IPC HANDLERS: WINDOW MANAGEMENT & 3-STATE DYNAMIC REDUCTION
// -------------------------------------------------------------
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

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  }

  if (mode === 'micro') {
    mainWindow.setMinimumSize(300, 52);
    mainWindow.setHasShadow(false);
    mainWindow.setSize(380, 58, true);
  } else if (mode === 'compact') {
    mainWindow.setMinimumSize(460, 180);
    mainWindow.setHasShadow(true);
    mainWindow.setSize(520, 220, true);
  } else {
    // 'full'
    mainWindow.setMinimumSize(720, 480);
    mainWindow.setHasShadow(true);
    mainWindow.setSize(960, 600, true);
  }

  event.sender.send('window-mode-changed', mode);
});

ipcMain.on('window-set-size', (event, { width, height }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setMinimumSize(Math.min(width, 300), Math.min(height, 52));
  mainWindow.setSize(width, height, true);
});

ipcMain.on('window-set-always-on-top', (event, flag) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(Boolean(flag), 'floating');
  event.sender.send('window-always-on-top-changed', mainWindow.isAlwaysOnTop());
});

ipcMain.handle('window-get-state', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { isMaximized: false, isAlwaysOnTop: false, width: 960, height: 600 };
  }
  const [width, height] = mainWindow.getSize();
  return {
    isMaximized: mainWindow.isMaximized(),
    isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
    width,
    height
  };
});

// -------------------------------------------------------------
// IPC HANDLERS: SERVER & OS SYSTEM INTEGRATION
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// APP LIFECYCLE
// -------------------------------------------------------------
app.whenReady().then(async () => {
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
