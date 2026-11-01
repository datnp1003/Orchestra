// Preload — contextBridge an toàn (nodeIntegration OFF)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orchestra', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, cb) => {
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
