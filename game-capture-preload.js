const { contextBridge, ipcRenderer } = require('electron');

let stopFn = null;

contextBridge.exposeInMainWorld('gameCapture', {
  started: (info) => ipcRenderer.send('game-capture-started', info),
  chunk: (buf) => ipcRenderer.send('game-capture-chunk', buf),
  videoChunk: (buf, type, timestamp) => ipcRenderer.send('medal-video-chunk', buf, type, timestamp),
  audioChunk: (buf) => ipcRenderer.send('medal-audio-chunk', buf),
  audioFileChunk: (buf) => ipcRenderer.send('loopback-audio-chunk', buf),
  loopbackStarted: (info) => ipcRenderer.send('loopback-started', info),
  loopbackFailed: (msg) => ipcRenderer.send('loopback-failed', msg),
  loopbackStopped: () => ipcRenderer.send('loopback-stopped'),
  stats: (info) => ipcRenderer.send('medal-capture-stats', info),
  stopped: () => ipcRenderer.send('game-capture-stopped'),
  failed: (msg) => ipcRenderer.send('game-capture-failed', msg),
  onPtt: (cb) => ipcRenderer.on('medal-ptt', (_e, held) => cb(Boolean(held))),
  onAudioMode: (cb) => ipcRenderer.on('medal-audio-mode', (_e, mode) => cb(mode || {})),
  onLoopbackControl: (cb) => ipcRenderer.on('loopback-control', (_e, action) => cb(action)),
  registerStop: (fn) => {
    stopFn = typeof fn === 'function' ? fn : null;
  }
});

ipcRenderer.on('game-capture-stop', () => {
  if (typeof stopFn === 'function') stopFn();
});
