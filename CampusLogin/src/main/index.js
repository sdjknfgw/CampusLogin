// CampusLogin 主进程：托盘常驻 + 网络变化监听 + 档案匹配 + 登录向导
// 约束（项目记忆）：空闲 CPU≈0%；面板关闭即销毁渲染进程；托盘图标用 16px
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, dialog } = require('electron');
const os = require('os');
const path = require('path');
const https = require('https');
const settings = require('./settings');
const portal = require('./portal');
const discovery = require('./discovery');
const capture = require('./capture');

// 单实例锁：二次启动直接唤出面板
if (!app.requestSingleInstanceLock()) { app.quit(); }

let tray = null;
let panel = null;
let appQuitting = false;
const iconDir = path.join(__dirname, '..', '..', 'build');

// ---------------- 托盘 ----------------
const trayIcons = {
  idle:    () => nativeImage.createFromPath(path.join(iconDir, 'tray-offline-16.png')),
  offline: () => nativeImage.createFromPath(path.join(iconDir, 'tray-offline-16.png')),
  busy:   () => nativeImage.createFromPath(path.join(iconDir, 'tray-busy-16.png')),
  online: () => nativeImage.createFromPath(path.join(iconDir, 'tray-online-16.png')),
  error:  () => nativeImage.createFromPath(path.join(iconDir, 'tray-error-16.png'))
};

function setTray(state, tip) {
  if (!tray) return;
  const img = (trayIcons[state] || trayIcons.idle)();
  tray.setImage(img);
  tray.setToolTip(tip || `CampusLogin - ${stateLabel(state)}`);
}

function stateLabel(s) {
  return { idle: '未配置', offline: '未认证', busy: '正在登录', online: '已认证', error: '已停止（需人工处理）' }[s] || s;
}

function createTray() {
  tray = new Tray(trayIcons.idle());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => showPanel() },
    { label: '立即登录', click: () => portal.triggerNow('tray-manual') },
    { label: '新网络登录向导', click: () => runCaptureWizard() },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: settings.load().autoStart, click: (mi) => { settings.setAutoStart(mi.checked); } },
    { type: 'separator' },
    { label: '退出', click: () => { appQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showPanel()); // 左键开面板（项目记忆约定）
}

// ---------------- 面板窗口 ----------------
function showPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({
    width: 460,
    height: 720,
    show: false,
    frame: false,               // 无边框赛博风
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0e17',
    webPreferences: {
      preload: path.join(__dirname, '..', 'panel', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  panel.setMenuBarVisibility(false);
  panel.loadFile(path.join(__dirname, '..', 'panel', 'index.html'));
  panel.once('ready-to-show', () => panel.show());
  panel.on('closed', () => { panel = null; }); // 关闭即销毁渲染进程（降低内存）
}

// ---------------- 网络变化监听 ----------------
// 每 15s 快照"接口签名 + 默认网关"：变化 → 重新匹配档案 → 触发引擎
let lastNetSig = '';
let lastGateway = '';
let lastGateways = [];
let lastSsid = '';
function netSignature() {
  try {
    const parts = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) parts.push(`${name}:${a.address}`);
      }
    }
    return parts.sort().join('|');
  } catch { return ''; }
}

let netTimer = null;
let gatewayProbeTimer = null;
let captureInProgress = false;
let lastAutoCaptureKey = '';
let selectionDialogOpen = false;
let promptedChoiceKey = '';
let networkChoice = null;

function networkKey(net) {
  return `${net.ssid || ''}|${(net.gateways || []).slice().sort().join(',')}`;
}

function portalIdentity(profile) {
  return [...new Set([...(profile.hosts || []), profile.host].filter(Boolean))].sort().join(',');
}

async function askForProfileChoice(net, candidates) {
  const key = networkKey(net);
  if (networkChoice && networkChoice.key === key) {
    const remembered = candidates.find(p => p.id === networkChoice.profileId);
    if (remembered) return remembered;
    networkChoice = null;
  }
  if (selectionDialogOpen || promptedChoiceKey === key) return null;
  selectionDialogOpen = true;
  promptedChoiceKey = key;
  showPanel();
  try {
    const buttons = candidates.map(p => `${p.name}  (${portalIdentity(p) || p.host})`);
    buttons.push('稍后再选');
    const result = await dialog.showMessageBox(panel, {
      type: 'question',
      title: '选择校园网门户',
      message: '当前网络匹配到多个门户档案，请选择要使用的网络。',
      detail: `Wi-Fi：${net.ssid || '未知'}\n网关：${(net.gateways || []).join(', ') || '未知'}`,
      buttons,
      cancelId: buttons.length - 1,
      defaultId: 0,
      noLink: true
    });
    const selected = candidates[result.response];
    if (!selected) {
      settings.pushLog('warn', '门户档案有冲突，等待手动选择');
      return null;
    }
    networkChoice = { key, profileId: selected.id };
    settings.setActiveProfileId(selected.id);
    settings.pushLog('info', `已选择门户档案: ${selected.name}（${selected.host}）`);
    return selected;
  } finally {
    selectionDialogOpen = false;
  }
}

async function autoCaptureForNetwork(net, reason) {
  const key = `${net.ssid || ''}|${(net.gateways || []).join(',')}`;
  if (captureInProgress || !key.replace(/\|/g, '')) return;
  if (key === lastAutoCaptureKey && reason !== 'startup') return;
  captureInProgress = true;
  try {
    const found = await discovery.discover();
    if (!found.best) return; // 只在确认是 Dr.COM 门户时自动弹向导
    lastAutoCaptureKey = key;
    settings.pushLog('info', `发现未配置校园网（${net.ssid || net.gateway || '未知网络'}），自动打开登录向导`);
    await runCaptureWizard();
  } finally {
    captureInProgress = false;
  }
}

async function refreshNetworkContext(reason) {
  const sig = netSignature();
  const gateways = await discovery.defaultGateways();
  const gateway = gateways[0] || '';
  const ssid = await discovery.currentSsid();
  const netChanged = sig !== lastNetSig || gateway !== lastGateway || gateways.join('|') !== lastGateways.join('|') || ssid !== lastSsid;
  lastNetSig = sig;
  lastGateway = gateway;
  lastGateways = gateways;
  lastSsid = ssid;

  const net = { gateway, gateways, ssid };
  const candidates = settings.matchProfiles(net);
  const hasPortalConflict = candidates.length > 1 && new Set(candidates.map(portalIdentity)).size > 1;
  const matched = hasPortalConflict
    ? await askForProfileChoice(net, candidates)
    : (candidates[0] || null);
  portal.currentProfileCtx.net = net;
  portal.currentProfileCtx.profile = matched;

  if (netChanged) {
    settings.pushLog('info', `网络变化(${reason}): 网关=${gateway || '?'} SSID=${ssid || '?'} → 档案「${matched ? matched.name : '无'}」`);
    if (matched) portal.triggerNow('net-change');
    else if (!hasPortalConflict) autoCaptureForNetwork(net, reason).catch(e => settings.pushLog('warn', '自动向导未启动: ' + e.message));
    return matched;
  }
  return matched;
}

function startNetWatch() {
  // 首次立即解析一次（同步后续周期对比）
  refreshNetworkContext('startup').then(() => {
    netTimer = setInterval(() => refreshNetworkContext('timer').catch(() => {}), 15000);
    // 无匹配档案时，每 60s 轻量复查网关（用户可能新连了未配置的网络）
    gatewayProbeTimer = setInterval(async () => {
      const matched = settings.matchProfile({ gateways: lastGateways, gateway: lastGateway, ssid: '' });
      if (!matched && lastGateway) {
        portal.currentProfileCtx.net = { gateways: lastGateways, gateway: lastGateway, ssid: '' };
        portal.currentProfileCtx.profile = null;
        autoCaptureForNetwork(portal.currentProfileCtx.net, 'gateway-recheck').catch(() => {});
      }
    }, 60000);
  });
}

// ---------------- 引擎回调 ----------------
function onEngineChange(snap) {
  setTray(snap.state);
  try {
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send('engine-state', { ...snap, stateLabel: stateLabel(snap.state) });
    }
  } catch {}
}

function notifyUser(title, body) {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false, icon: path.join(iconDir, 'icon.png') });
      n.on('click', () => showPanel());
      n.show();
    }
  } catch {}
}

// ---------------- 登录抓包向导 ----------------
function forwardCaptureEvent(evt) {
  if (evt.type === 'log') settings.pushLog('info', '[向导] ' + evt.msg);
  try {
    if (panel && !panel.isDestroyed()) panel.webContents.send('capture-event', evt);
  } catch {}
}

function runCaptureWizard() {
  if (portal.currentProfileCtx.profile) {
    // 已有匹配档案仍允许手动开向导（换账号/重新学习）
    settings.pushLog('info', '手动启动新网络登录向导');
  }
  return capture.startWizard({
    onEvent: forwardCaptureEvent
  }).then((profile) => {
    if (profile) {
      refreshNetworkContext('capture-saved').then(() => {
        portal.triggerNow('profile-saved');
        forwardCaptureEvent({ type: 'done', profile });
      });
    }
    return profile;
  });
}

// ---------------- IPC ----------------
ipcMain.handle('get-init', () => {
  const s = settings.load();
  return {
    account: s.credentials.account,
    hasPassword: !!s.credentials.passwordEncrypted,
    carrierId: s.credentials.carrierId,
    customSuffix: s.credentials.customSuffix,
    autoLogin: s.autoLogin,
    autoStart: s.autoStart,
    learnedSuffix: s.credentials.learnedSuffix,
    learnedAccount: s.credentials.learnedAccount,
    logs: s.logs.slice(0, 30),
    carriers: settings.CARRIER_OPTIONS,
    snapshot: portal.getSnapshot(),
    stateLabel: stateLabel(portal.getState()),
    profiles: settings.listProfiles().map(p => ({
      id: p.id, name: p.name, host: p.host, hosts: p.hosts || [p.host],
      ssids: p.ssids, gateways: p.gateways,
      createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
      active: p.id === settings.getActiveProfileId()
    })),
    network: portal.currentProfileCtx.net,
    activeProfileId: settings.getActiveProfileId()
    ,version: app.getVersion()
  };
});

ipcMain.handle('save-config', (_e, cfg) => {
  const s = settings.load();
  s.credentials.account = (cfg.account || '').trim();
  s.credentials.carrierId = cfg.carrierId || 'campus';
  s.credentials.customSuffix = (cfg.customSuffix || '').trim();
  s.autoLogin = !!cfg.autoLogin;
  if (!s.credentials.account) return { ok: false, msg: '请填写学号' };
  // 密码必须存在：新输入的，或之前已加密保存的
  if (!cfg.password && !s.credentials.passwordEncrypted) return { ok: false, msg: '请输入认证密码' };
  if (cfg.password) settings.setPassword(cfg.password);
  settings.save();
  settings.pushLog('info', '配置已保存');
  portal.triggerNow('config-saved'); // 新配置立即生效探测
  return { ok: true };
});

// 重连测试：主动注销 → 引擎立即探测并自动重连
ipcMain.handle('force-reauth', async () => {
  const profile = portal.currentProfileCtx.profile;
  if (!profile) return { ok: false, msg: '当前网络没有匹配档案，请先运行新网络登录向导' };
  settings.pushLog('info', '手动触发重连测试：注销当前会话');
  const r = await portal.logout(profile);
  if (!r.ok) {
    const portalDown = /不可达|超时|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH/i.test(r.msg || '');
    return {
      ok: false,
      msg: portalDown
        ? '门户尚未连通（开机后校园网就绪约需 1~2 分钟），已自动进入快速重试，无需反复点击'
        : '注销请求失败: ' + r.msg
    };
  }
  setTimeout(() => portal.triggerNow('manual-logout'), 800); // 等内核释放会话
  return { ok: true, msg: '已注销，等待自动重连（约 5~30 秒）' };
});

// 测试登录：用面板当前凭据直接登录（不落盘，先验证再保存）
ipcMain.handle('test-login', async (_e, cfg) => {
  const profile = portal.currentProfileCtx.profile;
  if (!profile) return { ok: false, msg: '当前网络没有匹配档案，请先运行「新网络登录向导」' };

  const account = (cfg.account || '').trim();
  let suffix = '';
  if (cfg.carrierId === 'auto') suffix = settings.load().credentials.learnedSuffix || '';
  else if (cfg.carrierId === 'custom') suffix = (cfg.customSuffix || '').trim();
  else suffix = (settings.CARRIER_OPTIONS.find(o => o.id === cfg.carrierId) || {}).suffix ?? '';
  const full = suffix && !account.toLowerCase().endsWith(suffix.toLowerCase()) ? account + suffix : account;

  const probe = await portal.chkstatus(profile);
  if (!probe.reachable) return { ok: false, msg: '门户不可达，请确认已连接校园网 WiFi' };
  // 同一账号视为已在线（后缀可能由内核补全，如 26250102 vs 26250102@cmcc）
  const sameAccount = probe.online && (
    probe.uid.toLowerCase() === full.toLowerCase() ||
    probe.uid.toLowerCase().startsWith(full.toLowerCase()) ||
    full.toLowerCase().startsWith(probe.uid.toLowerCase())
  );
  if (sameAccount) {
    // 已在线：顺便学习后缀（auto 模式首次配置即可用）
    const s = settings.load();
    if (full && probe.uid.toLowerCase().startsWith(full.slice(0, account.length).toLowerCase()) && probe.uid.length > account.length) {
      const learned = probe.uid.slice(account.length);
      if (learned !== s.credentials.learnedSuffix || probe.uid !== s.credentials.learnedAccount) {
        s.credentials.learnedSuffix = learned;
        s.credentials.learnedAccount = probe.uid;
        settings.save();
      }
    }
    return { ok: true, msg: `已在线（${probe.uid}），无需登录`, uid: probe.uid };
  }
  const r = await portal.login(profile, full, cfg.password || settings.getPassword());
  settings.pushLog(r.ok ? 'info' : 'warn', `测试登录: ${r.ok ? '成功' : '失败 ' + r.msg}`);
  if (r.ok) {
    const s = settings.load();
    s.credentials.learnedSuffix = full.slice(account.length);
    s.credentials.learnedAccount = full;
    settings.save();
  }
  return r;
});

ipcMain.handle('manual-login', () => { portal.triggerNow('manual'); return { ok: true }; });
ipcMain.handle('set-autostart', (_e, on) => { settings.setAutoStart(!!on); return { ok: true }; });

ipcMain.handle('open-portal', () => {
  const profile = portal.currentProfileCtx.profile;
  const host = profile ? profile.host : '172.19.0.1';
  shell.openExternal(`http://${host}/`);
  return { ok: true };
});

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.github.com/repos/sdjknfgw/CampusLogin/releases/latest', {
      headers: {
        'User-Agent': 'CampusLogin-Updater',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub 返回 HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('无法解析 GitHub Release 信息')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
  });
}

function compareVersions(a, b) {
  const parts = value => String(value).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

ipcMain.handle('check-updates', async () => {
  try {
    const release = await fetchLatestRelease();
    const currentVersion = app.getVersion();
    const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
    if (!latestVersion) return { ok: false, msg: 'Release 缺少版本号' };
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      notes: release.body || '此版本没有提供更新说明。',
      url: release.html_url || 'https://github.com/sdjknfgw/CampusLogin/releases/latest'
    };
  } catch (error) {
    return { ok: false, msg: error.message || '检查更新失败' };
  }
});

ipcMain.handle('open-release-page', (_e, url) => {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.pathname.split('/').slice(0, 3).join('/') !== '/sdjknfgw/CampusLogin') {
    return { ok: false, msg: '下载地址无效' };
  }
  shell.openExternal(parsed.href);
  return { ok: true };
});

// 档案管理
ipcMain.handle('list-profiles', () => settings.listProfiles());
ipcMain.handle('delete-profile', (_e, id) => {
  settings.deleteProfile(id);
  settings.pushLog('info', `已删除网络档案: ${id}`);
  refreshNetworkContext('profile-deleted').catch(() => {});
  return { ok: true };
});
ipcMain.handle('set-active-profile', (_e, id) => {
  settings.setActiveProfileId(id);
  const candidates = settings.matchProfiles(portal.currentProfileCtx.net || {});
  if (candidates.length > 1 && candidates.some(p => p.id === id)) {
    networkChoice = { key: networkKey(portal.currentProfileCtx.net || {}), profileId: id };
  }
  refreshNetworkContext('profile-switched').then(() => portal.triggerNow('profile-switched'));
  return { ok: true };
});
ipcMain.handle('clear-active-profile', () => {
  settings.setActiveProfileId('');
  refreshNetworkContext('profile-auto').then(() => portal.triggerNow('profile-auto'));
  return { ok: true };
});

// 向导
ipcMain.handle('start-capture', async (_e, host) => {
  const profile = host
    ? await capture.startWizardWithHost(host, {
        onEvent: (evt) => forwardCaptureEvent(evt)
      })
    : await runCaptureWizard();
  return { ok: !!profile, profile };
});
ipcMain.handle('cancel-capture', () => {
  capture.cancelWizard();
  return { ok: true };
});

// 窗口控制
ipcMain.handle('win-close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); return { ok: true }; });
ipcMain.handle('win-minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); return { ok: true }; });

// ---------------- 生命周期 ----------------
app.whenReady().then(async () => {
  createTray();
  portal.start(onEngineChange, notifyUser);
  await refreshNetworkContext('startup');
  startNetWatch();
  setTray(portal.getState());
  showPanel();

  // 自启登记：打包模式下把真实 exe 写入登录项
  const s = settings.load();
  if (s.autoStart) settings.setAutoStart(true);

  // 无档案（全新安装/换了学校）→ 引导跑登录向导
  if (s.profiles.length === 0) {
    settings.pushLog('info', '未检测到网络档案，启动登录向导');
    setTimeout(() => {
      if (!captureInProgress && portal.currentProfileCtx.net) {
        autoCaptureForNetwork(portal.currentProfileCtx.net, 'startup').catch(() => {});
      }
    }, 800);
  } else if (!portal.currentProfileCtx.profile) {
    // 有档案但当前网络不匹配：自动打开一次向导，新网络登录后会记住档案
    autoCaptureForNetwork(portal.currentProfileCtx.net, 'startup').catch(() => {});
  }
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => { appQuitting = true; portal.stop(); clearInterval(netTimer); clearInterval(gatewayProbeTimer); });
app.on('second-instance', () => showPanel());
app.commandLine.appendSwitch('disable-renderer-backgrounding');
