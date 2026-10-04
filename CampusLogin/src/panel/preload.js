// 预加载：安全暴露 IPC 给面板渲染进程（contextIsolation）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('campus', {
  getInit: () => ipcRenderer.invoke('get-init'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  testLogin: (cfg) => ipcRenderer.invoke('test-login', cfg),
  manualLogin: () => ipcRenderer.invoke('manual-login'),
  forceReauth: () => ipcRenderer.invoke('force-reauth'),
  setAutoStart: (on) => ipcRenderer.invoke('set-autostart'),
  openPortal: () => ipcRenderer.invoke('open-portal'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  openReleasePage: (url) => ipcRenderer.invoke('open-release-page', url),
  onEngineState: (cb) => ipcRenderer.on('engine-state', (_e, snap) => cb(snap)),
  // 档案管理
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),
  setActiveProfile: (id) => ipcRenderer.invoke('set-active-profile', id),
  clearActiveProfile: () => ipcRenderer.invoke('clear-active-profile'),
  // 登录向导（host 可选：手动指定门户地址，跳过自动发现）
  startCapture: (host) => ipcRenderer.invoke('start-capture', host),
  cancelCapture: () => ipcRenderer.invoke('cancel-capture'),
  onCaptureEvent: (cb) => ipcRenderer.on('capture-event', (_e, evt) => cb(evt)),
  onNeedCapture: (cb) => ipcRenderer.on('need-capture', () => cb()),
  onNoProfileMatch: (cb) => ipcRenderer.on('no-profile-match', () => cb()),
  // 窗口控制（无边框）
  winClose: () => ipcRenderer.invoke('win-close'),
  winMinimize: () => ipcRenderer.invoke('win-minimize')
});
