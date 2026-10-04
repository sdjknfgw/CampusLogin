// 门户自动发现：用户答"门户地址没测过"——换网络时软件得自己找到认证门户在哪
// 策略（低频、短超时、只在无匹配档案时运行）：
//   1) 从系统路由表取默认网关（Windows: ipconfig/route print，兜底常见段）
//   2) 网关本身多半就是门户（校园网常见：网关=门户=172.19.0.1）
//   3) 候选清单 = [网关:80, 网关:801] + 已知地址（向后兼容）
//   4) 对每个候选发一次 GET /（或 /drcom/chkstatus），识别 Dr.COM ePortal 特征
//   5) 识别成功的地址交给 capture.js 向导用；全部失败 → 提示手动输入地址
const { execFile } = require('child_process');
const http = require('http');
const os = require('os');

// 已知门户地址（向后兼容；老用户已有档案时不依赖这里）
const KNOWN_HOSTS = ['172.19.0.1'];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

// Windows 默认网关：ipconfig 找"默认网关 . . . . . . . . . . . . : x.x.x.x"
async function defaultGateway() {
  const all = await defaultGateways();
  return all[0] || '';
}

// 返回所有活动网卡的默认网关。多网卡/宿舍网桥场景下，单一网关会漏掉可用门户。
async function defaultGateways() {
  const found = [];
  if (process.platform === 'win32') {
    const out = await run('ipconfig', ['/all']);
    const gws = [];
    for (const m of out.matchAll(/默认网关[.\s]*:\s*([\d.]+)/g)) {
      const ip = m[1].trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0' && !gws.includes(ip)) gws.push(ip);
    }
    if (gws.length) found.push(...gws);
    // 兜底：route print 0.0.0.0 的 Gateway 列
    const r = await run('route', ['print', '0.0.0.0']);
    for (const line of r.split(/\r?\n/)) {
      const m = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)/);
      if (m && m[1] !== '0.0.0.0' && !found.includes(m[1])) found.push(m[1]);
    }
  }
  // 非 Windows / 解析失败：退到"本机所在网段的 .1"
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (/^(172\.(1[6-9]|2\d|3[01])\.|10\.|192\.168\.)/.test(it.address)) {
        const guess = it.address.split('.').slice(0, 3).join('.') + '.1';
        if (!found.includes(guess)) found.push(guess);
      }
    }
  }
  return found;
}

// 当前 SSID（Windows: netsh wlan show interfaces；非 WiFi / 失败返回 ''）
async function currentSsid() {
  if (process.platform !== 'win32') return '';
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  const m = out.match(/SSID\s*:\s*(.+)/);
  return m ? m[1].trim() : '';
}

// 探测单个地址是不是 Dr.COM ePortal 门户
// 返回 { reachable, isDrcom, host, port }
function probeHost(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/`, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36' }
    }, res => {
      let body = '';
      res.on('data', d => { body += d; if (body.length > 200000) req.destroy(); });
      res.on('end', () => {
        const lower = body.toLowerCase();
        // Dr.COM ePortal 首页特征：页面引用 drcom 内核接口 / ePortal 路径
        const isDrcom = /drcom|eportal|portalver|a4[13]\.js/i.test(body);
        resolve({ reachable: true, isDrcom, host, port });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, isDrcom: false, host, port }); });
    req.on('error', () => resolve({ reachable: false, isDrcom: false, host, port }));
  });
}

// 完整发现流程：返回 { gateway, ssid, candidates: [{host, port, isDrcom, reachable}], best }
// best = 第一个 isDrcom 的候选（Dr.COM 家族内无需区分具体版本——登录模板由向导抓取）
async function discover() {
  const gateways = await defaultGateways();
  const gateway = gateways[0] || '';
  const ssid = await currentSsid();

  const hosts = [];
  for (const gw of gateways) if (gw && !hosts.includes(gw)) hosts.push(gw);
  for (const h of KNOWN_HOSTS) if (!hosts.includes(h)) hosts.push(h);

  const candidates = [];
  for (const host of hosts) {
    // 80 与 801 都试（chkstatus 在 80，login/logout 在 801，探测首页即可识别）
    const results = await Promise.all([
      probeHost(host, 80),
      probeHost(host, 801)
    ]);
    for (const r of results) candidates.push(r);
  }
  return {
    gateway,
    ssid,
    candidates,
    best: candidates.find(c => c.isDrcom) || null
  };
}

module.exports = { discover, defaultGateway, defaultGateways, currentSsid, probeHost };
