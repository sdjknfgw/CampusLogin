// 登录抓包向导（capture.js）
// 解决"在自己浏览器登录软件抓不到请求"的问题：把登录向导搬进软件内的浏览器窗口。
// 用户操作不变——页面还是学校官方门户原页，还是原账号密码点原登录按钮；
// 软件在旁边用 webRequest 旁听这次登录请求，把接口+参数模板记进档案。
//
// 捕获对象：
//   1) 登录请求：URL 里含账号/密码字段（DDDDD+upass / user_account+user_password / ...）
//      → 原始参数按顺序保留，敏感值替换为 {{account}}/{{password}} 占位符
//   2) 探测请求：登录前浏览器必调的 chkstatus 类接口（只读）→ 存为 probe 模板
//   3) 注销请求：如登录后调用了 logout → 存为 logout 模板（可选）
const { BrowserWindow } = require('electron');
const http = require('http');
const settings = require('./settings');
const discovery = require('./discovery');

// 已知登录字段名组合（覆盖 Dr.COM 两套参数风格 + 常见变体）
// 注意：① 全部小写——classifyParams/templatize 比较时 key 已 toLowerCase；
//       ② Dr.COM 老内核字段名是 DDDDD（5 个 D），不是 DDDD——错一个字母就抓不到账号
const ACCOUNT_KEYS = ['ddddd', 'user_account', 'account', 'username', 'user', 'uid', 'name'];
const PASSWORD_KEYS = ['upass', 'user_password', 'password', 'pass', 'pwd', 'passwd'];
const ACTION_KEYS = ['action', 'ac_action', 'op'];

// 状态
let captureWin = null;
let captured = null; // { loginUrl, loginParams: [[k,v]...], probeUrl, probeParams, logoutUrl, logoutParams, host, port }

// ---------- URL 解析 ----------
function parseUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const params = [];
    // 保留原始顺序（URLSearchParams 保序，但与字符串保序一致；直接用 sp 即可）
    const sp = u.searchParams;
    for (const [k, v] of sp.entries()) params.push([k, v]);
    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      hash: u.hash || '',
      params
    };
  } catch { return null; }
}

// 判断一组参数是不是"登录提交"：同时含账号字段和密码字段
function classifyParams(params) {
  const keys = params.map(([k]) => k.toLowerCase());
  const hasAccount = keys.some(k => ACCOUNT_KEYS.includes(k));
  const hasPassword = keys.some(k => PASSWORD_KEYS.includes(k));
  return { hasAccount, hasPassword };
}

// 把敏感值换成占位符（按当前输入匹配；匹配不上就按"最长的非空敏感字段"猜）
function templatize(params, creds) {
  const out = [];
  for (const [k, v] of params) {
    const lk = k.toLowerCase();
    let val = v;
    if (ACCOUNT_KEYS.includes(lk) && creds.account && (v === creds.account || v === creds.full || v.startsWith(creds.account))) {
      val = v === creds.full ? '{{account}}' : '{{account}}' + v.slice(creds.account.length);
    } else if (PASSWORD_KEYS.includes(lk)) {
      // 密码字段无论当前凭据是否已保存，都必须脱敏；否则首次向导可能把明文写入档案。
      val = '{{password}}';
    } else if (lk === 'wlan_user_ip' && /^\d+\.\d+\.\d+\.\d+$/.test(v)) {
      val = '{{localIp}}';
    } else if (/^v$|^_$|^_nocache|^rnd/i.test(lk) && /^\d+$/.test(v)) {
      val = '{{epochMs}}';
    }
    out.push([k, val]);
  }
  return out;
}

// ---------- 主流程 ----------
// startWizard(opts) → Promise<profile|null>
// opts: { onEvent(evt) }  evt: {type:'log'|'found'|'saved'|'closed', ...}
function startWizard(opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  return new Promise(async (resolve, reject) => {
    // 1) 发现门户地址
    onEvent({ type: 'log', msg: '正在探测当前网络的门户地址…' });
    let disc = await discovery.discover();
    let host = (disc.best && disc.best.host) || disc.gateway || '';
    // 手动指定地址（面板输入）：优先于自动发现
    if (opts._hostOverride) {
      host = opts._hostOverride;
      disc = { ...disc, best: { host, port: 80, isDrcom: true }, gateway: host };
    }
    if (!host) {
      onEvent({ type: 'log', msg: '未找到门户（默认网关解析失败）' });
      resolve(null);
      return;
    }
    onEvent({ type: 'log', msg: `门户地址: http://${host}/（${disc.best ? '已识别 Dr.COM' : '按网关猜测'}）` });

    captured = null;
    let finished = false; // 防 finish 重复执行（poll 与 close 可能同时触发）

    // 2) 开内置浏览器窗口加载门户首页
    captureWin = new BrowserWindow({
      width: 520,
      height: 760,
      title: '登录向导 · 在下面页面正常登录一次',
      backgroundColor: '#0a0e17',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 门户是 http 明文站点；默认设置即可加载
      }
    });

    const sess = captureWin.webContents.session;

    // 3) 旁听请求（登录/探测/注销三类）
    sess.webRequest.onBeforeRequest((details, callback) => {
      try {
        const parsed = parseUrl(details.url);
        if (!parsed || details.method !== 'GET') { callback({}); return; }
        const { hasAccount, hasPassword } = classifyParams(parsed.params);
        if (hasAccount && hasPassword) {
          captured = captured || {};
          captured.login = parsed;
          onEvent({ type: 'log', msg: `捕获登录请求: ${parsed.path}` });
          onEvent({ type: 'found-login', host: parsed.host, port: parsed.port });
        } else if (/chkstatus|status|online/i.test(parsed.path) && !hasPassword) {
          captured = captured || {};
          if (!captured.probe) {
            captured.probe = parsed;
            onEvent({ type: 'log', msg: `捕获探测接口: ${parsed.path}` });
          }
        } else if (/logout/i.test(parsed.path)) {
          captured = captured || {};
          if (!captured.logout) {
            captured.logout = parsed;
            onEvent({ type: 'log', msg: `捕获注销接口: ${parsed.path}` });
          }
        }
      } catch {}
      callback({}); // 放行，绝不影响用户正常登录
    });

    captureWin.on('closed', () => { captureWin = null; });

    const startUrl = disc.best
      ? `http://${host}${disc.best.port === 801 ? ':801' : ''}/`
      : `http://${host}/`;
    captureWin.loadURL(startUrl).catch(() => {});

    // 4) 轮询等待登录成功（窗口开着时每 3 秒探测一次门户状态）
    const poll = setInterval(async () => {
      if (!captureWin || captureWin.isDestroyed()) return;
      if (!captured || !captured.login) return; // 还没看到登录请求
      // 用捕获的登录请求所在 host/port 验证；探测路径优先用捕获到的 probe，
      // 没有则退回 Dr.COM 标准 chkstatus（非 Dr.COM 门户走到这步说明已捕获登录，
      // 但 probe 未捕获——保守退回，验证失败不影响保存）
      const probePath = captured.probe ? captured.probe.path : '/drcom/chkstatus';
      const probePort = captured.probe ? captured.probe.port : 80;
      const ok = await quickOnlineCheck(captured.login.host, probePort, probePath);
      if (ok === 'online') {
        finish();
      } else if (ok === 'offline') {
        onEvent({ type: 'log', msg: '已看到登录请求，等待门户确认…' });
      }
    }, 3000);

    function cleanup() {
      clearInterval(poll);
      try { if (captureWin && !captureWin.isDestroyed()) captureWin.destroy(); } catch {}
      captureWin = null;
    }

    // 5) 生成档案
    async function finish() {
      if (finished) return; // poll 与 close 可能同时触发，只执行一次
      if (!captured || !captured.login) { cleanup(); resolve(null); return; }
      finished = true;
      const creds = settings.load().credentials;
      const full = settings.fullAccount();
      const password = settings.getPassword();
      if (!creds.account || !password) {
        // 没配全局凭据：向导里学到的模板也存，但标记缺凭据
        settings.pushLog('warn', '档案已捕获，但尚未填写全局账号密码，请在面板保存');
      }
      const profile = buildProfile(captured, {
        account: creds.account, full, password,
        gateway: disc.gateway, gateways: disc.gateways || [], ssid: disc.ssid
      });
      settings.upsertProfile(profile);
      settings.setActiveProfileId(profile.id);
      settings.pushLog('info', `新网络档案已保存: ${profile.name}（${profile.host}）`);
      onEvent({ type: 'saved', profile });
      cleanup();
      resolve(profile);
    }

    // 窗口被用户直接关掉：若已捕获登录请求，也尝试保存（用户可能登完就关）
    captureWin.on('close', () => {
      setTimeout(() => {
        if (finished) return;
        if (captured && captured.login) finish();
        else { clearInterval(poll); resolve(null); }
      }, 300);
    });
  });
}

// 独立于档案的裸在线检查（验证登录是否真的成功）
// path 可指定：Dr.COM 是 /drcom/chkstatus；其他门户用向导捕获到的 probe 路径
function quickOnlineCheck(host, port, path) {
  return new Promise((resolve) => {
    const url = `http://${host}:${port}${path || '/drcom/chkstatus'}?callback=x&v=${Date.now()}`;
    const req = http.get(url, { timeout: 3000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          // 兼容 JSONP 与纯 JSON 两种响应
          let json = body;
          const s = body.indexOf('('), e = body.lastIndexOf(')');
          if (s >= 0 && e > s) json = body.slice(s + 1, e);
          const j = JSON.parse(json);
          const online = j.result === 1 || j.online === 1 || j.status === 1;
          resolve(online ? 'online' : 'offline');
        } catch { resolve('unknown'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('unknown'); });
    req.on('error', () => resolve('unknown'));
  });
}

// 由捕获结果构建档案
function buildProfile(cap, ctx) {
  const host = cap.login.host;
  const id = 'p' + Date.now().toString(36);
  const name = ctx.ssid ? `WiFi「${ctx.ssid}」` : `网络 ${host}`;

  // 登录模板：原始顺序保留 + 占位符替换
  const loginRaw = templatize(cap.login.params, ctx);
  // 端口：登录请求 URL 端口优先；DDDDD 风格（老内核 login 在 80）
  const loginPort = cap.login.port || 80;

  // 探测模板：优先用捕获到的；没有则用 Dr.COM 标准 chkstatus（同 host）
  let probePort = 80, probePath = '/drcom/chkstatus', probeRaw = [['callback', '{{randomCb}}']];
  if (cap.probe) {
    probePort = cap.probe.port;
    probePath = cap.probe.path;
    probeRaw = templatize(cap.probe.params, ctx);
    // 探测接口不含账号密码，templatize 只会处理 ip/rnd 类；确保有 callback
    if (!probeRaw.some(([k]) => k === 'callback')) probeRaw.unshift(['callback', '{{randomCb}}']);
  }

  // 注销模板（可选）
  let logout = null;
  if (cap.logout) {
    logout = { port: cap.logout.port, method: 'GET', path: cap.logout.path, rawParams: templatize(cap.logout.params, ctx) };
  } else if (/eportal|drcom/i.test(probePath + loginPort)) {
    // Dr.COM 兜底（老内核 logout 在 80；eportal 在 801）
    logout = { port: loginPort === 80 ? 80 : 801, method: 'GET', path: '/eportal/portal/logout', rawParams: [['callback', 'dr1003']] };
  }

  return {
    id,
    name,
    ssids: ctx.ssid ? [ctx.ssid] : [],
    gateways: ctx.gateways && ctx.gateways.length ? ctx.gateways : (ctx.gateway ? [ctx.gateway] : []),
    hosts: [host],
    host,
    probe: { port: probePort, method: 'GET', path: probePath, rawParams: probeRaw },
    login: {
      port: loginPort, method: 'GET', path: cap.login.path,
      rawParams: loginRaw,
      resultField: 'result',
      okValue: 1,
      accountField: (loginRaw.find(([k]) => ACCOUNT_KEYS.includes(k.toLowerCase())) || [])[0] || ''
    },
    logout,
    createdAt: new Date().toISOString(),
    lastUsedAt: ''
  };
}

// 手动指定门户地址（用户在面板输入）：跳过自动发现，直接开向导
async function startWizardWithHost(host, opts = {}) {
  const clean = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!clean) return null;
  // 先验证可达性（80 或 801 任一通即可）
  const p80 = await discovery.probeHost(clean, 80);
  const p801 = p80.reachable ? p80 : await discovery.probeHost(clean, 801);
  if (!p80.reachable && !p801.reachable) return null;
  return startWizard({ ...opts, _hostOverride: clean });
}

// 供主进程取消向导用
function cancelWizard() {
  try { if (captureWin && !captureWin.isDestroyed()) captureWin.destroy(); } catch {}
  captureWin = null;
}

module.exports = { startWizard, startWizardWithHost, cancelWizard, buildProfile, parseUrl, classifyParams };
