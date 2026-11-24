const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const FILTERS = [{ name: 'Activity files', extensions: ['fit', 'tcx', 'gpx'] }, { name: 'All files', extensions: ['*'] }];

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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
