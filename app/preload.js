'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('monitor', {
  list: () => ipcRenderer.invoke('monitor:list'),
  switchInput: request => ipcRenderer.invoke('monitor:switch', request),
});
