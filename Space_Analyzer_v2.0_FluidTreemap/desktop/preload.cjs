const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('spaceAPI', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  startScan: options => ipcRenderer.invoke('scan:start', options),
  controlScan: (taskId, action) => ipcRenderer.invoke('scan:control', { taskId, action }),
  onBatch: callback => subscribe('scan:batch', callback),
  onProgress: callback => subscribe('scan:progress', callback),
  onDone: callback => subscribe('scan:done', callback),
  onError: callback => subscribe('scan:error', callback)
});
