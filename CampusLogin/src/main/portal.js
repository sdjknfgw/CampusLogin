// 校园网门户协议引擎（v2：档案驱动，协议无关）
// 每个网络档案自带 probe/login/logout 三段接口模板（有序 rawParams + 占位符），
// 首次由登录向导从真实浏览器请求中捕获，之后按模板原样重放——换门户不用再逆向。
//
// 设计红线（设计文档 §7）：登录前必探测；失败退避；密码错误/连续3次失败即停；绝不盲目重试
const http = require('http');
const os = require('os');
const settings = require('./settings');

const TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 3000; // chkstatus 是本校内网接口，8s 全量超时会拖垮开机上线速度
const MAX_CONSECUTIVE_FAILS = 3;

// 在线心跳：45~75 秒随机（掉线后最迟 75 秒内被发现并自动重连）
const HEARTBEAT_MIN = 45 * 1000, HEARTBEAT_MAX = 75 * 1000;
// 未在线退避序列（±20% 抖动）
const BACKOFF_SEQ = [10, 30, 60, 120, 300, 600].map(s => s * 1000);
// 开机/触发后 2 分钟内走快速档（门户就绪滞后于系统网络就绪）
const FAST_BACKOFF_SEQ = [2, 3, 5, 8, 15, 30].map(s => s * 1000);
let fastUntil = 0;

// ---------------- JSONP 底层请求 ----------------
// 参数编码：与浏览器 jQuery $.param 一致（encodeURIComponent，不编码 @ 等标记符）；
// Dr.COM 老内核可能不解码 %40，禁用 URLSearchParams
function buildQuery(pairs) {
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// 本机校园网侧 IPv4（排除环回/链路本地/虚拟网卡；优先门户所在网段）
function localIp(preferGatewayPrefix) {
  const bad = /^(127\.|169\.254\.|198\.18\.)/;
  let fallback = '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal || bad.test(it.address)) continue;
      if (preferGatewayPrefix && it.address.startsWith(preferGatewayPrefix)) return it.address;
      if (!fallback) fallback = it.address;
    }
  }
  return fallback;
}

// 占位符替换：{{account}} {{password}} {{localIp}} {{randomCb}} {{epoch}} {{epochMs}}
function expandTemplate(rawParams, ctx) {
  return (rawParams || []).map(([k, v]) => {
    let val = String(v == null ? '' : v);
    val = val
      .replace(/\{\{account\}\}/g, ctx.account || '')
      .replace(/\{\{password\}\}/g, ctx.password || '')
      .replace(/\{\{localIp\}\}/g, ctx.localIp || '')
      .replace(/\{\{randomCb\}\}/g, 'jQuery' + Math.floor(Math.random() * 1e9))
      .replace(/\{\{epochMs\}\}/g, String(Date.now()))
      .replace(/\{\{epoch\}\}/g, String(Math.floor(Date.now() / 1000)));
    return [k, val];
  });
}

// 按档案接口模板发请求，返回解析后的 JSON（JSONP 剥壳）
function requestByTemplate(profile, tmplKey, ctx, timeoutMs) {
  const tmpl = profile[tmplKey];
  if (!tmpl || !tmpl.path) return Promise.reject(new Error(`档案缺少 ${tmplKey} 接口模板`));
  const host = ctx.portalHost || profile.host;
  const port = tmpl.port || 80;
  const pairs = expandTemplate(tmpl.rawParams, ctx);
  // 保底：无论模板里有没有，都追加 v=<随机> 防缓存（浏览器 $.param 行为同款）
  if (!pairs.some(([k]) => k === 'v')) pairs.push(['v', String(Date.now() + Math.floor(Math.random() * 1000))]);

  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}${tmpl.path}?${buildQuery(pairs)}`;
    const req = http.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': `http://${host}/`,
        'Accept': '*/*'
      }
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const s = body.indexOf('('), e = body.lastIndexOf(')');
          if (s < 0 || e <= s) {
            // 非 JSONP（纯 JSON 或 HTML）：兼容纯 JSON
            const t = body.trim();
            if (t.startsWith('{')) { resolve(JSON.parse(t)); return; }
            throw new Error('非 JSONP 响应: ' + body.slice(0, 120));
          }
          resolve(JSON.parse(body.slice(s + 1, e)));
        } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// ---------------- 协议接口（档案驱动） ----------------
// 在线状态：{ reachable, online, uid, ip, oltime }
// uid 从常见字段名里取（不同门户字段名不同：uid/account/user_account）
async function chkstatus(profile) {
  const hosts = [profile.host].filter(Boolean);
  let lastError = '';
  for (const portalHost of hosts) {
    try {
      const j = await requestByTemplate(profile, 'probe', { portalHost }, PROBE_TIMEOUT_MS);
      const uid = j.uid || j.account || j.user_account || j.userid || '';
      return {
        reachable: true, online: j.result === 1 || j.online === 1 || j.status === 1,
        uid, ip: j.v46ip || j.wlan_user_ip || j.user_ip || '', oltime: j.oltime || 0,
        host: portalHost, raw: j
      };
    } catch (err) { lastError = err.message; }
  }
  return { reachable: false, online: false, uid: '', ip: '', oltime: 0, error: lastError || '门户不可达' };
}

// 登录：{ ok, msg, raw }
async function login(profile, account, password, authenticatedIp = '') {
  const hosts = [profile.host].filter(Boolean);
  let last = null;
  for (const portalHost of hosts) {
    try {
      const clientIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(authenticatedIp)
        ? authenticatedIp : localIp(gatewayPrefixOf(profile, portalHost));
      const ctx = { account, password, localIp: clientIp, portalHost };
      const j = await requestByTemplate(profile, 'login', ctx, TIMEOUT_MS);
      const resultField = (profile.login && profile.login.resultField) || 'result';
      const okValue = (profile.login && profile.login.okValue !== undefined) ? profile.login.okValue : 1;
      const ok = j[resultField] === okValue || j[resultField] === String(okValue);
      if (ok || /已经在线|密码错误|密码不正确|用户名或密码/i.test(j.msg || '')) return { ok, msg: ok ? '' : (j.msg || j.message || j.error || '未知错误'), raw: j, host: portalHost };
      last = j;
    } catch (err) { last = { networkError: err.message }; }
  }
  const responseMessage = last && (last.msg || last.message || last.error);
  if (last && !last.networkError) return { ok: false, msg: responseMessage || '门户拒绝登录（result=' + last.result + '）', raw: last };
  return { ok: false, msg: 'NETWORK: ' + (responseMessage || '所有门户地址均不可达'), raw: null };
}

// 注销：{ ok, msg }
async function logout(profile) {
  let lastError = '';
  for (const portalHost of [profile.host].filter(Boolean)) {
    try {
      const j = await requestByTemplate(profile, 'logout', { portalHost }, TIMEOUT_MS);
      return { ok: true, msg: '', raw: j, host: portalHost };
    } catch (err) { lastError = err.message; }
  }
  return { ok: false, msg: lastError || '所有门户地址均不可达' };
}

// 档案 host 是网关本身时，localIp 优先返回同网段地址
function gatewayPrefixOf(profile, portalHost = profile.host) {
  const parts = String(portalHost || '').split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.') + '.';
  return '';
}

// ---------------- 引擎状态机 ----------------
// state: 'idle'(未配置) | 'offline'(未认证) | 'busy'(登录中) | 'online'(已认证) | 'error'(停止，需人工)
let state = 'idle';
let timer = null;
let backoffIdx = 0;
let consecutiveFails = 0;
let lastProbe = null;
let activeProfile = null;   // 本轮使用的档案
let onStateChange = () => {};
let notify = () => {};

function setState(s, extra = {}) {
  state = s;
  onStateChange({ state: s, ...extra, lastProbe, profileId: activeProfile ? activeProfile.id : '' });
}

function schedule(delayMs) {
  clearTimeout(timer);
  const jitter = delayMs * (0.8 + Math.random() * 0.4); // ±20% 抖动
  timer = setTimeout(() => cycle('retry').catch(() => {}), jitter);
}

// 单轮：匹配档案 → 探测 → 决策 → （必要时）登录
async function cycle(reason) {
  clearTimeout(timer);
  const s = settings.load();
  const password = settings.getPassword();
  const account = settings.fullAccount();

  // 当前网络档案（index.js 已匹配好注入；兜底再匹配一次）
  activeProfile = currentProfileCtx.profile || settings.matchProfile(currentProfileCtx.net || {});
  if (!activeProfile) { setState('idle', { reason: 'no-profile' }); return; }
  if (!account || !password) { setState('idle', { reason: 'no-credentials' }); return; }

  // 1) 探测（登录前必先探测——绝不盲目提交）
  const probe = await chkstatus(activeProfile);
  lastProbe = probe;

  // 门户不可达：不在校园网 / 网络未就绪 → 待机，等网络变化再触发
  if (!probe.reachable) {
    if (reason !== 'retry' || backoffIdx === 0) {
      settings.pushLog('warn', `门户不可达（${probe.error || '网络未就绪'}），等待网络恢复`);
    }
    backoffIdx = Math.min(backoffIdx + 1, BACKOFF_SEQ.length - 1);
    setState('offline', { reason: 'portal-unreachable' });
    const seq = Date.now() < fastUntil ? FAST_BACKOFF_SEQ : BACKOFF_SEQ;
    schedule(seq[Math.min(backoffIdx, seq.length - 1)]);
    return;
  }

  // 2) 已在线
  if (probe.online) {
    // uid 后缀自动学习（auto 模式核心）
    if (probe.uid && probe.uid !== account) {
      const base = s.credentials.account;
      if (settings.accountsMatch(probe.uid, account)) {
        const learned = probe.uid.slice(base.length);
        if (learned !== s.credentials.learnedSuffix) {
          s.credentials.learnedSuffix = learned;
          s.credentials.learnedAccount = probe.uid;
          settings.save();
          settings.pushLog('info', `自动学习运营商后缀: ${learned || '(无)'}（来自在线账号 ${probe.uid}）`);
        }
      }
      // 别的账号在线
      if (!settings.accountsMatch(probe.uid, account)) {
        settings.pushLog('warn', `检测到其他账号在线: ${probe.uid}，本软件不动作`);
        setState('error', { reason: 'other-account', otherUid: probe.uid });
        return;
      }
    }
    backoffIdx = 0; consecutiveFails = 0;
    setState('online', { uid: probe.uid, ip: probe.ip, oltime: probe.oltime });
    schedule(HEARTBEAT_MIN + Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN));
    return;
  }

  // 3) 未认证 → 自动登录
  if (!s.autoLogin) { setState('offline', { reason: 'auto-login-disabled' }); return; }

  setState('busy', { reason });
  settings.pushLog('info', `使用当前选择的门户档案登录: ${activeProfile.name}（${activeProfile.host}）`);
  const r = await login(activeProfile, account, password, probe.ip);
  settings.pushLog(r.ok ? 'info' : 'warn', `登录(${reason}) [${activeProfile.name}]: ${r.ok ? '成功' : '失败 ' + r.msg}`);

  if (r.ok) {
    backoffIdx = 0; consecutiveFails = 0;
    activeProfile.lastUsedAt = new Date().toISOString();
    settings.upsertProfile(activeProfile);
    notify('校园网登录成功', `账号 ${account} 已认证（${activeProfile.name}）`);
    setState('online', { uid: account });
    schedule(HEARTBEAT_MIN + Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN));
    return;
  }

  // 4) 失败分类（设计文档 §7.3/7.4）
  const msg = r.msg || '';
  // 内核对在线 IP 重复登录返回「已经在线」——视为成功（会话已存在）
  if (/已经在线/.test(msg)) {
    consecutiveFails = 0;
    activeProfile.lastUsedAt = new Date().toISOString();
    settings.upsertProfile(activeProfile);
    settings.pushLog('info', '会话已在线（' + new Date().toLocaleTimeString('zh-CN') + '）');
    setState('online', { account: settings.fullAccount() });
    schedule(HEARTBEAT_MIN + Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN));
    return;
  }
  // 只有明确的密码错误才算凭据错误（停止重试防锁定）；
  // 「无法获取用户认证账号」等协议/会话类报文可重试（可能是时机问题）
  const isCredentialError = r.raw !== null && /密码错误|密码不正确|用户名或密码|password.*(wrong|error|incorrect)/i.test(msg);
  if (isCredentialError) {
    settings.pushLog('error', `凭据错误，停止重试: ${msg}`);
    notify('校园网登录失败', `凭据错误: ${msg}，请打开面板修改`);
    setState('error', { reason: 'bad-credentials', msg });
    return;
  }

  if (r.raw !== null && /AC认证失败|AC验证失败|AC认证拒绝/i.test(msg)) {
    settings.pushLog('error', `AC 拒绝登录，已停止自动重试: ${msg}`);
    notify('校园网登录被 AC 拒绝', '已暂停自动重试，请用浏览器确认当前网络门户和认证状态');
    setState('error', { reason: 'ac-auth-failed', msg });
    return;
  }

  consecutiveFails++;
  if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    settings.pushLog('error', `连续失败 ${consecutiveFails} 次，停止重试防风控: ${msg}`);
    notify('校园网自动登录已暂停', `连续失败 ${consecutiveFails} 次: ${msg}`);
    setState('error', { reason: 'consecutive-fails', msg });
    return;
  }

  setState('offline', { reason: 'login-failed', msg });
  const seqF = Date.now() < fastUntil ? FAST_BACKOFF_SEQ : BACKOFF_SEQ;
  schedule(seqF[Math.min(backoffIdx++, seqF.length - 1)]);
}

// ---------------- 对外 API ----------------
// currentProfileCtx 由 index.js 维护：{ profile, net: { gateway, ssid } }
const currentProfileCtx = { profile: null, net: {} };

function start(_onStateChange, _notify) {
  onStateChange = _onStateChange || onStateChange;
  notify = _notify || notify;
  fastUntil = Date.now() + 120000; // 开机启动场景：前 2 分钟走快速重试档
  clearTimeout(timer);
  timer = setTimeout(() => cycle('startup').catch(e => settings.pushLog('error', '引擎异常: ' + e.message)), 500);
}

// 网络变化触发：立即探测（限频：距上次触发 <5s 则忽略）
let lastTrigger = 0;
function triggerNow(reason = 'manual') {
  const now = Date.now();
  if (now - lastTrigger < 5000) return;
  lastTrigger = now;
  backoffIdx = 0;
  consecutiveFails = 0;
  fastUntil = now + 120000;
  clearTimeout(timer);
  timer = setTimeout(() => cycle(reason).catch(e => settings.pushLog('error', '引擎异常: ' + e.message)), 500);
}

function stop() { clearTimeout(timer); setState('idle', { reason: 'stopped' }); }

function getState() { return state; }

function getSnapshot() {
  return {
    state,
    lastProbe,
    profileId: activeProfile ? activeProfile.id : '',
    profileName: activeProfile ? activeProfile.name : '',
    account: settings.load().credentials.account,
    full: settings.fullAccount()
  };
}

module.exports = {
  chkstatus, login, logout,
  start, stop, triggerNow, getState, getSnapshot,
  currentProfileCtx // index.js 写入匹配到的档案/网络上下文
};
