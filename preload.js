'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  restart: () => ipcRenderer.invoke('harness:restart'),
  status: () => ipcRenderer.invoke('harness:status'),
  saveKey: (key) => ipcRenderer.invoke('harness:saveKey', key),
  checkUpdate: () => ipcRenderer.invoke('update:check-now'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  onStatusText: (cb) => ipcRenderer.on('harness:status-text', (_e, text) => cb(text))
});
