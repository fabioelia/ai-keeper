'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const PUSH_CHANNELS = new Set(['sessions:updated', 'suggestion:ready', 'respond:update', 'gemma:status']);

contextBridge.exposeInMainWorld('aiKeeper', {
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  suggest: (sessionId) => ipcRenderer.invoke('session:suggest', sessionId),
  respond: (payload) => ipcRenderer.invoke('session:respond', payload),
  openProject: (sessionId) => ipcRenderer.invoke('session:open', sessionId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  installHooks: () => ipcRenderer.invoke('hooks:install'),
  uninstallHooks: () => ipcRenderer.invoke('hooks:uninstall'),
  hooksStatus: () => ipcRenderer.invoke('hooks:status'),
  gemmaStatus: () => ipcRenderer.invoke('gemma:status'),
  on: (channel, callback) => {
    if (!PUSH_CHANNELS.has(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
