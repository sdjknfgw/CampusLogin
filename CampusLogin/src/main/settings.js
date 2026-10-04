// 设置读写：JSON 持久化到 %APPDATA%\CampusLogin\settings.json
// 密码加密：本机密钥文件(.key) + AES-256-GCM；settings.json 泄露也无法解出密码
//
// v2 结构（多网络档案）：
//   credentials  —— 全局一套账号密码（用户答：所有校园网同一套凭据）
//   profiles[]   —— 每个网络一份档案：如何找到门户 + 如何探测/登录（参数模板）
//   activeProfileId —— 当前匹配的网络（按网关/SSID 自动匹配，也可手动指定）
//
// 档案参数模板 = 有序 [ [key, value], ... ] 数组（不是对象——Dr.COM 老内核对参数顺序敏感，
// 必须保留抓包时的原始顺序）。value 里可含占位符，登录时替换：
//   {{account}}  {{password}}  {{localIp}}  {{random}}  {{epoch}}
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CARRIER_OPTIONS = [
  { id: 'auto',   name: '自动检测',        suffix: null },   // 从 chkstatus uid 学习
  { id: 'campus', name: '校园用户',        suffix: ''  },
  { id: 'dx',     name: '校园电信',        suffix: '@dx' },
  { id: 'lt',     name: '校园联通',        suffix: '@lt' },
  { id: 'custom', name: '自定义后缀',      suffix: null }    // 用 customSuffix 字段
];

function defaults() {
  return {
    // ---- 全局凭据（旧版 account/passwordEncrypted 的归并，迁移时自动搬过来）----
    credentials: {
      account: '',
      passwordEncrypted: '',  // base64 密文（AES-256-GCM）
      carrierId: 'campus',    // CARRIER_OPTIONS id
      customSuffix: '',       // carrierId=custom 时生效，如 @cmcc
      learnedSuffix: '',      // 从 chkstatus uid 学到的后缀（auto 模式用）
      learnedAccount: ''
    },
    autoLogin: true,
    autoStart: true,
    activeProfileId: '',      // '' = 自动匹配
    profiles: [],             // 见文件头注释
    logs: []                  // 最近 100 条 { t, level, msg }
  };
}

let cache = null;

function settingsPath() {
  return path.join(app.getPath('appData'), 'CampusLogin', 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    cache = { ...defaults(), ...parsed };
  } catch {
    cache = defaults();
  }
  migrate(cache);
  return cache;
}

// 旧版（v1，无 profiles）→ v2：把旧配置收编成一份默认档案
function migrate(s) {
  if (!Array.isArray(s.profiles)) s.profiles = [];
  // v1 顶层字段搬进 credentials
  if (s.account !== undefined || s.passwordEncrypted !== undefined) {
    if (s.account !== undefined && !s.credentials.account) s.credentials.account = s.account;
    if (s.passwordEncrypted !== undefined && !s.credentials.passwordEncrypted) {
      s.credentials.passwordEncrypted = s.passwordEncrypted;
    }
    if (s.carrierId !== undefined) s.credentials.carrierId = s.carrierId;
    if (s.customSuffix !== undefined) s.credentials.customSuffix = s.customSuffix;
    if (s.learnedSuffix !== undefined) s.credentials.learnedSuffix = s.learnedSuffix;
    if (s.learnedAccount !== undefined) s.credentials.learnedAccount = s.learnedAccount;
    delete s.account; delete s.passwordEncrypted; delete s.carrierId;
    delete s.customSuffix; delete s.learnedSuffix; delete s.learnedAccount;
    s._migrated = true;
  }
  // v1 有凭据但无档案 → 生成一份"默认网络"档案（参数与 v1 portal.js 写死的完全一致）
  if (s._migrated && s.profiles.length === 0 && s.credentials.account) {
    s.profiles.push({
      id: 'default',
      name: '默认网络',
      ssids: [],
      gateways: [],               // 空 = 通配（迁移档案保持旧行为）
      host: '172.19.0.1',
      probe: {
        port: 80, method: 'GET', path: '/drcom/chkstatus',
        rawParams: [['callback', '{{randomCb}}']]
      },
      login: {
        port: 801, method: 'GET', path: '/eportal/portal/login',
        rawParams: [
          ['callback', 'dr1003'],
          ['login_method', '1'],
          ['user_account', '{{account}}'],
          ['user_password', '{{password}}'],
          ['wlan_user_ip', '{{localIp}}'],
          ['wlan_user_ipv6', ''],
          ['wlan_user_mac', '000000000000'],
          ['wlan_ac_ip', ''],
          ['wlan_ac_name', ''],
          ['jsVersion', '4.1.3'],
          ['terminal_type', '1'],
          ['lang', 'zh-cn']
        ],
        resultField: 'result',
        okValue: 1,
        accountField: 'user_account'
      },
      logout: {
        port: 801, method: 'GET', path: '/eportal/portal/logout',
        rawParams: [['callback', 'dr1003']]
      },
      createdAt: new Date().toISOString(),
      lastUsedAt: ''
    });
    s.activeProfileId = 'default';
  }
  delete s._migrated;
}

function save() {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
}

// ---- 密码加密（本机密钥文件 + AES-256-GCM）----
function keyFilePath() { return path.join(app.getPath('appData'), 'CampusLogin', '.key'); }

let cachedKey = null;
function masterKey() {
  if (cachedKey) return cachedKey;
  const p = keyFilePath();
  try {
    cachedKey = fs.readFileSync(p);
    if (cachedKey.length !== 32) throw new Error('bad key');
  } catch {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(p, cachedKey, { mode: 0o600 }); // 仅当前用户可读
  }
  return cachedKey;
}

function setPassword(plain) {
  const s = load();
  if (!plain) { s.credentials.passwordEncrypted = ''; save(); return; }
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    s.credentials.passwordEncrypted = Buffer.concat([iv, tag, enc]).toString('base64');
    save();
  } catch (e) {
    throw new Error('密码加密失败: ' + e.message);
  }
}

function getPassword() {
  const s = load();
  const enc = s.credentials.passwordEncrypted;
  if (!enc) return '';
  try {
    const buf = Buffer.from(enc, 'base64');
    if (buf.length < 29) return ''; // iv12+tag16+至少1
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc2 = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc2), decipher.final()]).toString('utf8');
  } catch {
    return ''; // 旧格式/密钥不符，视为未设置
  }
}

// ---- 运营商后缀解析（按全局凭据）----
function resolveSuffix() {
  const s = load();
  const c = s.credentials;
  const opt = CARRIER_OPTIONS.find(o => o.id === c.carrierId) || CARRIER_OPTIONS[1];
  if (opt.id === 'auto') return c.learnedSuffix != null ? c.learnedSuffix : '';
  if (opt.id === 'custom') return c.customSuffix || '';
  return opt.suffix;
}

// 组合完整登录账号：学号 + 后缀（去重：用户已手输后缀则不重复拼）
function fullAccount() {
  const s = load();
  const suffix = resolveSuffix();
  const account = s.credentials.account;
  if (!suffix) return account;
  return account.toLowerCase().endsWith(suffix.toLowerCase()) ? account : account + suffix;
}

// ---- 档案操作 ----
function listProfiles() { return load().profiles; }

function getProfile(id) { return load().profiles.find(p => p.id === id) || null; }

function getActiveProfileId() { return load().activeProfileId; }

function setActiveProfileId(id) {
  const s = load();
  s.activeProfileId = id || '';
  save();
}

function upsertProfile(profile) {
  const s = load();
  const i = s.profiles.findIndex(p => p.id === profile.id);
  if (i >= 0) s.profiles[i] = { ...s.profiles[i], ...profile };
  else s.profiles.push(profile);
  save();
  return profile;
}

function deleteProfile(id) {
  const s = load();
  s.profiles = s.profiles.filter(p => p.id !== id);
  if (s.activeProfileId === id) s.activeProfileId = '';
  save();
}

// 档案匹配：先按网关精确匹配，再按 SSID；返回最匹配的档案或 null
// ctx = { gateway: '172.19.0.1', ssid: 'Campus-5G' }
function matchProfile(ctx) {
  return matchProfiles(ctx)[0] || null;
}

// 返回同一网络条件下的全部候选档案，用于门户地址冲突时让用户选择。
function matchProfiles(ctx) {
  const s = load();
  const profiles = s.profiles;
  if (profiles.length === 0) return [];
  const gateways = ctx && (ctx.gateways || (ctx.gateway ? [ctx.gateway] : []));
  const ssid = String(ctx && ctx.ssid || '').toLowerCase();
  const ranked = profiles.map(p => {
    const gatewayMatch = gateways && gateways.some(g => (p.gateways || []).includes(g));
    const ssidMatch = !!ssid && (p.ssids || []).some(x => x.toLowerCase() === ssid);
    // Gateway identifies the network first; SSID breaks ties between gateways reused by multiple campuses.
    return { profile: p, score: (gatewayMatch ? 100 : 0) + (ssidMatch ? 10 : 0) };
  });
  const bestScore = Math.max(...ranked.map(x => x.score));
  if (bestScore > 0) return ranked.filter(x => x.score === bestScore).map(x => x.profile);

  // Legacy profiles with no network identifiers remain a last-resort fallback.
  if (gateways && gateways.length) {
    const wildcard = profiles.find(p => (p.gateways || []).length === 0 && (p.ssids || []).length === 0);
    if (wildcard) return [wildcard];
  }
  if (s.activeProfileId && (!gateways || !gateways.length) && !ssid) {
    const active = profiles.find(x => x.id === s.activeProfileId);
    return active ? [active] : [];
  }
  return [];
}

// ---- 日志 ----
function pushLog(level, msg) {
  const s = load();
  s.logs.unshift({ t: new Date().toISOString(), level, msg });
  if (s.logs.length > 100) s.logs.length = 100;
  save();
}

function setAutoStart(on) {
  const s = load();
  s.autoStart = !!on;
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: app.getPath('exe') }); } catch {}
  save();
}

module.exports = {
  load, save, setPassword, getPassword,
  resolveSuffix, fullAccount, pushLog, setAutoStart,
  CARRIER_OPTIONS, settingsPath,
  // 档案 API
  listProfiles, getProfile, getActiveProfileId, setActiveProfileId, upsertProfile, deleteProfile,
  matchProfile, matchProfiles
};
