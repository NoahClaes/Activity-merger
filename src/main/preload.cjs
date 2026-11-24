const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
