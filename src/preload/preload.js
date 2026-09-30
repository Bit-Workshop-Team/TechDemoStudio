'use strict';

/**
 * 预加载脚本：渲染进程唯一可用的能力入口（contextIsolation + sandbox）。
 * 只暴露必要的 IPC 通道，不暴露任何 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    quit: () => ipcRenderer.invoke('app:quit'),
    showConfigFile: () => ipcRenderer.invoke('app:showConfig'),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    reportError: (info) => ipcRenderer.send('renderer:error', info)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (patch) => ipcRenderer.invoke('config:save', patch),
    defaults: () => ipcRenderer.invoke('config:defaults')
  },
  llm: {
    test: (payload) => ipcRenderer.invoke('llm:test', payload),
    models: (payload) => ipcRenderer.invoke('llm:models', payload)
  },
  demo: {
    start: (boardId) => ipcRenderer.invoke('demo:start', boardId),
    exit: () => ipcRenderer.invoke('demo:exit'),
    state: () => ipcRenderer.invoke('demo:state'),
    onStarted: (cb) => subscribe('demo:started', cb),
    onExited: (cb) => subscribe('demo:exited', cb),
    onBlocked: (cb) => subscribe('demo:blocked-action', cb),
    onKeyProgress: (cb) => subscribe('demo:key-progress', cb)
  },
  gomoku: {
    move: (payload) => ipcRenderer.invoke('gomoku:move', payload),
    cancel: (requestId) => ipcRenderer.send('gomoku:cancel', requestId),
    onDelta: (cb) => subscribe('gomoku:delta', cb),
    boardText: (board) => ipcRenderer.invoke('game:board-text', board)
  },
  local: {
    think: (payload) => ipcRenderer.invoke('local:think', payload)
  }
};

contextBridge.exposeInMainWorld('demoAPI', api);
