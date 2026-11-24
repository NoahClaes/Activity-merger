const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

const FILTERS = [{ name: 'Activity files', extensions: ['fit', 'tcx', 'gpx', 'zip'] }, { name: 'All files', extensions: ['*'] }];

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'Activity Merger',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Never navigate away or open new windows inside the app; links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

ipcMain.handle('open-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: FILTERS });
  if (res.canceled) return [];
  return Promise.all(
    res.filePaths.map(async (p) => ({ name: path.basename(p), path: p, data: new Uint8Array(await fs.readFile(p)) }))
  );
});

ipcMain.handle('save-file', async (event, { defaultPath, ext, data }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, typeof data === 'string' ? data : Buffer.from(data));
  return res.filePath;
});

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// ---------------------------------------------------------------- updates
// Only the installed app updates itself (not `npm start`, not the portable exe).
const canUpdate = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdate(payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update-status', payload);
}
autoUpdater.on('update-available', (info) => sendUpdate({ state: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'ready', version: info.version }));
autoUpdater.on('error', (err) => sendUpdate({ state: 'error', message: String(err?.message ?? err).split('\n')[0] }));

ipcMain.handle('app-info', () => ({ version: app.getVersion(), canUpdate }));
ipcMain.handle('update-check', async () => {
  if (!canUpdate) return { state: 'unsupported' };
  try {
    await autoUpdater.checkForUpdates();
    return { state: 'checking' };
  } catch (err) {
    return { state: 'error', message: String(err?.message ?? err).split('\n')[0] };
  }
});
ipcMain.handle('update-download', () => autoUpdater.downloadUpdate());
ipcMain.handle('update-install', () => autoUpdater.quitAndInstall(false, true));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
