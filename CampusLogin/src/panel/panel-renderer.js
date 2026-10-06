// 面板渲染逻辑：加载配置 / 保存 / 测试登录 / 档案管理 / 向导 / 状态与日志实时刷新
const $ = (id) => document.getElementById(id);
let engineState = 'idle';
let lastInit = null;
let latestReleaseUrl = 'https://github.com/sdjknfgw/CampusLogin/releases/latest';
const EXPRESSIONS = [
  ['happy', '连接顺利，今天也保持在线。'], ['thinking', '让我想想下一步。'],
  ['focused', '认证信息已准备好。'], ['confused', '网络似乎还在路上。'], ['celebrating', '连接完成，出发吧！'],
  ['eating_rice', '我吃白饭怎么了'], ['surprised', '咦？发现了新的网络线索。'],
  ['sleepy', '网络还没准备好，我先眯一会儿。'], ['curious', '前面是不是有新的连接？'],
  ['waving', '你好呀，今天也一起保持在线。']
];
let expressionIndex = Math.floor(Math.random() * EXPRESSIONS.length);
function showPersona(randomCharacter = false) {
  const el = $('persona');
  const [name] = EXPRESSIONS[expressionIndex];
  el.className = 'persona ' + name;
  el.querySelector('img').src = `assets/deepseek_mascot_${name}.png`;
  el.title = EXPRESSIONS[expressionIndex][1];
}

// ---------- 初始化 ----------
(async function init() {
  const data = await window.campus.getInit();
  lastInit = data;

  // 运营商下拉
  const sel = $('carrier');
  for (const c of data.carriers) {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.value = data.carrierId || 'campus';

  $('account').value = data.account || '';
  if (data.hasPassword) $('password').placeholder = '●●●●●●●●（已加密保存，留空不改）';
  $('customSuffix').value = data.customSuffix || '';
  $('swAuto').classList.toggle('on', !!data.autoLogin);
  $('swStart').classList.toggle('on', !!data.autoStart);

  renderProfiles(data);
  renderLogs(data.logs);
  applyEngineState({ state: data.snapshot.state, stateLabel: data.stateLabel, lastProbe: data.snapshot.lastProbe });
  onCarrierChange();
  showPersona(true);
  const version = data.version || '1.0.5';
  const updateReportRevision = `${version}-20261005`;
  if (localStorage.getItem('whats-new-version') !== updateReportRevision) {
    $('updateTitle').textContent = `已更新至 v${version}`;
    $('updateVersion').textContent = '本次更新';
    $('updateNotes').textContent = '• 新增运行日志一键复制，便于反馈登录错误\n• 登录优先使用门户回传的本机 IP；AC 拒绝时停止重复提交\n• 新增 10 种可点击切换的鲸鱼娘互动人偶\n• 发现新版本会自动打开 GitHub 发布页\n• 手机端修复运营商下拉菜单黑底黑字\n• 手机端适配常工院 26.0.0.1 网关与 172.19.0.1 认证门户';
    $('updateModal').classList.add('show');
    localStorage.setItem('whats-new-version', updateReportRevision);
  }
})();

// ---------- 运营商交互 ----------
function onCarrierChange() {
  const id = $('carrier').value;
  $('customSuffix').style.display = id === 'custom' ? 'block' : 'none';
  const hints = {
    auto: '自动检测：已在线时从门户回读你的真实后缀并记住',
    campus: '登录账号 = 学号（不加后缀）',
    dx: '登录账号 = 学号@dx',
    lt: '登录账号 = 学号@lt',
    custom: '移动等预绑定账号请输入后缀，如 @cmcc'
  };
  $('suffixHint').innerHTML = hints[id] || '';
}
$('carrier').addEventListener('change', onCarrierChange);

// ---------- 档案渲染 ----------
function renderProfiles(data) {
  const box = $('profileList');
  const net = data.network || {};
  const allGateways = (net.gateways && net.gateways.length ? net.gateways : (net.gateway ? [net.gateway] : []));
  const netTxt = [allGateways.length && ('网关 ' + allGateways.join(', ')), net.ssid && ('WiFi ' + net.ssid)].filter(Boolean).join(' · ');
  $('netInfo').textContent = netTxt || '';

  const profiles = data.profiles || [];
  if (profiles.length === 0) {
    box.innerHTML = '<div class="pempty">还没有任何网络档案。<br>连上校园网 WiFi 后点下面的「新网络登录向导」，在官方登录页正常登一次即可。</div>';
    return;
  }
  box.innerHTML = profiles.map(p => {
    const hosts = p.hosts && p.hosts.length ? p.hosts.join(',') : p.host;
    const sub = [hosts, p.ssids && p.ssids.length ? 'WiFi:' + p.ssids.join(',') : '', p.lastUsedAt ? '上次 ' + fmtTime(p.lastUsedAt) : '未用过']
      .filter(Boolean).join(' · ');
    return `<div class="pitem ${p.active ? 'active' : ''}">
      <div class="pdot"></div>
      <div class="pinfo">
        <div class="pname">${escapeHtml(p.name)}${p.active ? ' · 当前' : ''}</div>
        <div class="psub">${escapeHtml(sub)}</div>
      </div>
      <button class="puse" data-select="${escapeHtml(p.id)}" title="用于当前网络">使用</button>
      <button class="pdel" data-del="${escapeHtml(p.id)}" title="删除档案">✕</button>
    </div>`;
  }).join('');
  // 绑定删除
  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-del');
      await window.campus.deleteProfile(id);
      toast('档案已删除');
      refreshInit();
    });
  });
  box.querySelectorAll('[data-select]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-select');
      const result = await window.campus.setActiveProfile(id);
      if (result.ok) {
        toast('已为当前网络选择档案', 'ok');
        refreshInit();
      } else toast(result.msg || '无法应用此档案', 'err');
    });
  });
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function refreshInit() {
  const data = await window.campus.getInit();
  lastInit = data;
  renderProfiles(data);
  renderLogs(data.logs);
}

// ---------- 状态渲染 ----------
function applyEngineState(snap) {
  engineState = snap.state;
  $('led').className = 'led ' + (snap.state || 'idle');
  const map = {
    idle: '未配置', offline: '未认证', busy: '正在登录…',
    online: '已认证', error: '已停止（需处理）'
  };
  $('statusText').textContent = snap.stateLabel || map[snap.state] || snap.state;

  const p = snap.lastProbe || {};
  let sub = '';
  if (snap.state === 'online') {
    sub = `${snap.uid || p.uid || ''}${snap.profileName ? '  ·  ' + snap.profileName : ''}${p.ip ? '  ·  ' + p.ip : ''}`;
    if (p.oltime) {
      const h = Math.floor(p.oltime / 3600), m = Math.floor((p.oltime % 3600) / 60);
      sub += `  ·  已在线 ${h}h${m}m`;
    }
  } else if (snap.state === 'busy') {
    sub = '正在提交认证…';
  } else if (snap.state === 'error') {
    sub = snap.msg ? snap.msg : (snap.otherUid ? `其他账号在线: ${snap.otherUid}` : '请打开面板排查');
  } else if (snap.state === 'offline') {
    if (snap.reason === 'login-failed') {
      sub = `当前档案登录失败，仍使用「${snap.profileName || '已选档案'}」重试：${snap.msg || '未知错误'}`;
    } else sub = p.reachable === false ? '门户不可达（未连校园网？）' : '等待自动重试…';
  } else if (snap.state === 'idle' && snap.reason === 'no-profile') {
    sub = '当前网络没有档案，请点下方「新网络登录向导」';
  } else {
    sub = '请填写学号密码并保存';
  }
  $('statusSub').textContent = sub;
}

function renderLogs(logs) {
  const box = $('logbox');
  box.innerHTML = (logs || []).map(l => {
    const t = new Date(l.t);
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    return `<div class="log-${l.level}"><span class="log-time">${hh}</span>${escapeHtml(l.msg)}</div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 引擎状态推送
window.campus.onEngineState((snap) => {
  applyEngineState(snap);
  if (snap.state === 'online' || snap.state === 'error') {
    refreshInit();
  }
});

// 向导事件推送
window.campus.onCaptureEvent((evt) => {
  if (evt.type === 'log') {
    // 向导日志直接进面板日志区
    renderLogs([{ t: new Date().toISOString(), level: 'info', msg: '[向导] ' + evt.msg }].concat((lastInit && lastInit.logs) || []));
  } else if (evt.type === 'saved' || evt.type === 'done') {
    toast(`已记住「${evt.profile.name}」，下次自动登录`, 'ok');
    refreshInit();
    $('wizardHint').innerHTML = `✓ 已保存档案：<b>${escapeHtml(evt.profile.name)}</b>（${escapeHtml(evt.profile.host)}）。下次连这个网络会自动登录。`;
  } else if (evt.type === 'found-login') {
    toast('已捕获登录请求，等待门户确认…');
  }
});

window.campus.onNeedCapture(() => {
  toast('首次使用：请在弹出的登录页完成一次登录', 'ok');
  $('wizardHint').innerHTML = '首次使用：<b>在弹出的官方登录页正常登录一次</b>，软件自动记住这个网络。';
});
window.campus.onNoProfileMatch(() => {
  toast('当前网络没有匹配档案，请运行登录向导', 'err');
});

// ---------- 按钮 ----------
function collectCfg() {
  return {
    account: $('account').value.trim(),
    password: $('password').value,
    carrierId: $('carrier').value,
    customSuffix: $('customSuffix').value.trim(),
    autoLogin: $('swAuto').classList.contains('on')
  };
}

let toastTimer = null;
function toast(msg, cls = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function withBusy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⟳ 处理中…';
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

$('btnUpdate').addEventListener('click', () => withBusy($('btnUpdate'), async () => {
  const result = await window.campus.checkUpdates();
  if (!result.ok) return toast('检查更新失败：' + (result.msg || '请稍后重试'), 'err');
  if (!result.updateAvailable) return toast(`当前已是最新版 v${result.currentVersion}`, 'ok');
  const opened = await window.campus.openReleasePage(result.url);
  if (!opened.ok) return toast(opened.msg || '无法打开 GitHub 发布页', 'err');
  latestReleaseUrl = result.url;
  $('btnUpdateOpen').textContent = '打开 GitHub 发布页';
  $('updateTitle').textContent = '发现新版本';
  $('updateVersion').textContent = `当前版本 v${result.currentVersion}  →  最新版本 v${result.latestVersion}`;
  $('updateNotes').textContent = (result.notes || '此版本没有提供更新说明。') + '\n\n已在浏览器中打开 GitHub 发布页。';
  $('updateModal').classList.add('show');
}));

$('btnUpdateClose').addEventListener('click', () => $('updateModal').classList.remove('show'));
$('btnGuide').addEventListener('click', () => $('guideModal').classList.add('show'));
$('btnGuideClose').addEventListener('click', () => $('guideModal').classList.remove('show'));
$('guideModal').addEventListener('click', (event) => {
  if (event.target === $('guideModal')) $('guideModal').classList.remove('show');
});
$('updateModal').addEventListener('click', (event) => {
  if (event.target === $('updateModal')) $('updateModal').classList.remove('show');
});
$('btnUpdateOpen').addEventListener('click', async () => {
  const result = await window.campus.openReleasePage(latestReleaseUrl);
  if (!result.ok) return toast(result.msg || '无法打开 GitHub 发布页', 'err');
  $('updateModal').classList.remove('show');
});

$('persona').addEventListener('click', () => {
  expressionIndex = (expressionIndex + 1) % EXPRESSIONS.length;
  showPersona(false);
  toast(EXPRESSIONS[expressionIndex][1], 'ok');
});

$('btnTest').addEventListener('click', () => withBusy($('btnTest'), async () => {
  const cfg = collectCfg();
  if (!cfg.account) return toast('请先填写学号', 'err');
  const r = await window.campus.testLogin(cfg);
  if (r.ok) {
    toast(r.msg || '登录成功', 'ok');
    $('password').placeholder = '已验证 · 如需保存新密码请点击「保存并启用」';
    if (r.uid) $('suffixHint').innerHTML = `✓ 已验证账号: <b>${escapeHtml(r.uid)}</b>`;
  } else {
    toast('失败: ' + (r.msg || '未知错误'), 'err');
  }
}));

$('btnCopyLogs').addEventListener('click', async () => {
  const result = await window.campus.copyLogs();
  toast(result.ok ? `已复制 ${result.count} 条日志，可粘贴到聊天` : '复制日志失败', result.ok ? 'ok' : 'err');
});

$('btnReauth').addEventListener('click', () => withBusy($('btnReauth'), async () => {
  const r = await window.campus.forceReauth();
  toast(r.msg, r.ok ? 'ok' : 'err');
}));

$('btnSave').addEventListener('click', () => withBusy($('btnSave'), async () => {
  const cfg = collectCfg();
  if (!cfg.account) return toast('请先填写学号', 'err');
  const r = await window.campus.saveConfig(cfg);
  if (r.ok) {
    toast('已保存，自动登录已启用', 'ok');
    $('password').value = '';
    $('password').placeholder = '已加密保存 · 留空则不修改';
  } else {
    toast(r.msg || '保存失败', 'err');
  }
}));

// 新网络登录向导
$('btnWizard').addEventListener('click', () => withBusy($('btnWizard'), async () => {
  toast('已打开登录向导，请在弹出页面登录', 'ok');
  const r = await window.campus.startCapture();
  if (!r.ok) {
    toast('向导未完成（未捕获到登录请求）', 'err');
    $('wizardHint').innerHTML = '未捕获到登录请求。确认已连上校园网 WiFi；<b>自动探测失败时可在下方手动输入门户地址</b>再试。';
  }
}));

// 手动指定门户地址启动向导
$('btnManualWizard').addEventListener('click', () => withBusy($('btnManualWizard'), async () => {
  const host = $('manualHost').value.trim();
  if (!host) return toast('请先输入门户地址', 'err');
  toast(`正在连接 ${host} …`, 'ok');
  const r = await window.campus.startCapture(host);
  if (!r.ok) toast(`无法连接 ${host}，或未捕获到登录请求`, 'err');
}));

// 开关
$('swAuto').addEventListener('click', () => $('swAuto').classList.toggle('on'));
$('swStart').addEventListener('click', async () => {
  const on = !$('swStart').classList.contains('on');
  $('swStart').classList.toggle('on', on);
  await window.campus.setAutoStart(on);
  toast(on ? '已开启开机自启' : '已关闭开机自启');
});

// 密码可见性
$('btnEye').addEventListener('click', () => {
  const p = $('password');
  p.type = p.type === 'password' ? 'text' : 'password';
});

// 窗口控制
$('btnClose').addEventListener('click', () => window.campus.winClose());
$('btnMin').addEventListener('click', () => window.campus.winMinimize());
$('btnPortal').addEventListener('click', () => window.campus.openPortal());
