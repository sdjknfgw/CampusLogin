// 校园网 Dr.COM(ePortal 4.0) 门户协议引擎 —— Android 版（从 PC 端 portal.js 忠实移植）
// 探测：GET :80/drcom/chkstatus（JSONP，result==1 在线，uid 含运营商后缀）
// 登录：GET :801/eportal/portal/login（JSONP，明文账号密码 + wlan_user_ip）
// 设计红线（设计文档 §7）：登录前必探测；失败退避；密码错误/连续3次失败即停；绝不盲目重试
package com.campuslogin.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PortalEngine {
    public interface Listener {
        void onStateChanged(Snapshot s);
        void onNotify(String title, String msg);
    }

    public static class Snapshot {
        public final String state;      // idle | offline | busy | online | error
        public final String fullAccount;
        public final String uid;
        public final String ip;
        public final long oltime;       // 在线时长（秒）
        public final String msg;
        public final long updatedAt;

        Snapshot(String state, String fullAccount, String uid, String ip, long oltime, String msg) {
            this.state = state; this.fullAccount = fullAccount; this.uid = uid;
            this.ip = ip; this.oltime = oltime; this.msg = msg;
            this.updatedAt = System.currentTimeMillis();
        }
    }

    private String host() {
        return Prefs.selectedPortalHost(ctx);
    }
    private static final int TIMEOUT_MS = 8000;
    private static final int MAX_CONSECUTIVE_FAILS = 3;

    // 在线心跳：45~75 秒随机（拟真节奏；掉线后最迟 75 秒内被发现并自动重连）
    private static final long HEARTBEAT_MIN = 45_000, HEARTBEAT_MAX = 75_000;
    // 未在线退避序列（±20% 抖动）
    private static final long[] BACKOFF_SEQ = {10_000, 30_000, 60_000, 120_000, 300_000, 600_000};

    private final Context ctx;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService exec = Executors.newSingleThreadExecutor();

    private volatile String state = "idle";
    private volatile Snapshot lastSnapshot = new Snapshot("idle", "", "", "", 0, "");
    private int backoffIdx = 0;
    private int consecutiveFails = 0;
    private long lastTrigger = 0;
    private String notifiedPortalKey = "";
    private volatile boolean stopped = false;

    public PortalEngine(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    // ---------------- 对外 API ----------------
    public void start() {
        stopped = false;
        schedule(3000);
    }

    public void stop() {
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        exec.shutdownNow();
        setState("idle", "", "", "", 0, "已停止");
    }

    // 网络变化触发：立即探测（限频：距上次触发 <5s 则忽略）
    public void triggerNow(String reason) {
        long now = System.currentTimeMillis();
        if (now - lastTrigger < 5000) return;
        lastTrigger = now;
        backoffIdx = 0;
        handler.removeCallbacksAndMessages(null);
        schedule(500);
    }

    public Snapshot getSnapshot() { return lastSnapshot; }

    // ---------------- 单轮状态机 ----------------
    private void schedule(long delayMs) {
        if (stopped) return;
        long jitter = (long) (delayMs * (0.8 + Math.random() * 0.4)); // ±20% 抖动
        handler.postDelayed(() -> exec.execute(() -> cycle("retry")), jitter);
    }

    private void setState(String s, String fullAccount, String uid, String ip, long oltime, String msg) {
        state = s;
        Snapshot snap = new Snapshot(s, fullAccount, uid, ip, oltime, msg);
        lastSnapshot = snap;
        if (listener != null) handler.post(() -> listener.onStateChanged(snap));
    }

    private void cycle(String reason) {
        if (stopped) return;
        Prefs.Config s = Prefs.load(ctx);
        String account = Prefs.fullAccount(ctx);
        String password = s.password;

        if (s.account.isEmpty() || password.isEmpty()) {
            setState("idle", "", "", "", 0, "未配置");
            return;
        }

        if (host().isEmpty()) {
            String networkKey = Prefs.currentNetwork(ctx).key();
            if (!networkKey.equals(notifiedPortalKey)) {
                notifiedPortalKey = networkKey;
                notifyUser("未设置校园网门户", "打开应用检测或填写学校提供的门户 IP");
            }
            setState("offline", account, "", "", 0, "尚未设置校园网门户");
            schedule(BACKOFF_SEQ[Math.min(backoffIdx, BACKOFF_SEQ.length - 1)]);
            return;
        }
        notifiedPortalKey = "";

        // 1) 探测（登录前必先探测——绝不盲目提交）
        ProbeResult probe = chkstatus();
        if (probe == null) {
            // 门户不可达：不在校园网 / 网络未就绪 → 待机，等网络变化再触发
            if (!"retry".equals(reason) || backoffIdx == 0) {
                Prefs.pushLog(ctx, "warn", "门户不可达（网络未就绪或不在校园网），等待网络恢复");
            }
            backoffIdx = Math.min(backoffIdx + 1, BACKOFF_SEQ.length - 1);
            setState("offline", account, "", "", 0, "门户不可达");
            schedule(BACKOFF_SEQ[Math.min(backoffIdx, BACKOFF_SEQ.length - 1)]);
            return;
        }

        // 2) 已在线
        if (probe.online) {
            String uid = probe.uid == null ? "" : probe.uid;
            if (!uid.isEmpty() && !uid.equalsIgnoreCase(account)) {
                String base = s.account;
                if (accountsMatch(uid, account, base)) {
                    String learned = learnedSuffix(uid, base);
                    if (!learned.isEmpty()) Prefs.setLearned(ctx, learned, uid);
                    account = Prefs.fullAccount(ctx);
                } else {
                    // 别的账号在线（含本机其他账号）
                    Prefs.pushLog(ctx, "warn", "检测到其他账号在线: " + uid + "，本软件不动作");
                    setState("error", account, uid, probe.ip, probe.oltime, "其他账号在线: " + uid);
                    return;
                }
            }
            backoffIdx = 0; consecutiveFails = 0;
            setState("online", account, uid, probe.ip, probe.oltime, "");
            schedule(HEARTBEAT_MIN + (long) (Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN)));
            return;
        }

        // 3) 未认证 → 自动登录
        if (!s.autoLogin) {
            setState("offline", account, "", "", 0, "自动登录已关闭");
            return;
        }

        setState("busy", account, "", probe.ip, 0, "登录中…");
        LoginResult r = login(account, password);
        Prefs.pushLog(ctx, r.ok ? "info" : "warn", "登录(" + reason + "): " + (r.ok ? "成功" : "失败 " + r.msg));

        if (r.ok) {
            backoffIdx = 0; consecutiveFails = 0;
            notifyUser("校园网登录成功", "账号 " + account + " 已认证");
            setState("online", account, account, r.ip != null ? r.ip : probe.ip, 0, "");
            schedule(HEARTBEAT_MIN + (long) (Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN)));
            return;
        }

        // 4) 失败分类（设计文档 §7.3/7.4）
        String msg = r.msg == null ? "" : r.msg;
        // 内核对在线 IP 重复登录返回「已经在线」——视为成功（会话已存在）
        if (msg.contains("已经在线")) {
            consecutiveFails = 0;
            Prefs.pushLog(ctx, "info", "会话已在线（" + nowTime() + "）");
            setState("online", account, account, probe.ip, 0, "会话已存在");
            schedule(HEARTBEAT_MIN + (long) (Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN)));
            return;
        }
        // 只有明确的密码错误才算凭据错误（停止重试防锁定）；
        // 「无法获取用户认证账号」等协议/会话类报文可重试（可能是时机问题）
        boolean credentialError = r.raw != null && msg.matches("(?i).*密码错误.*|.*密码不正确.*|.*用户名或密码.*|.*password.*(wrong|error|incorrect).*");
        if (credentialError) {
            Prefs.pushLog(ctx, "error", "凭据错误，停止重试: " + msg);
            notifyUser("校园网登录失败", "凭据错误: " + msg + "，请打开应用修改");
            setState("error", account, "", probe.ip, 0, "凭据错误: " + msg);
            return;
        }

        consecutiveFails++;
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
            Prefs.pushLog(ctx, "error", "连续失败 " + consecutiveFails + " 次，停止重试防风控: " + msg);
            notifyUser("校园网自动登录已暂停", "连续失败 " + consecutiveFails + " 次: " + msg);
            setState("error", account, "", probe.ip, 0, "连续失败: " + msg);
            return;
        }

        setState("offline", account, "", probe.ip, 0, "登录失败: " + msg);
        schedule(BACKOFF_SEQ[Math.min(backoffIdx++, BACKOFF_SEQ.length - 1)]);
    }

    private boolean accountsMatch(String observed, String expected, String base) {
        String uid = observed.toLowerCase(java.util.Locale.ROOT);
        String full = expected.toLowerCase(java.util.Locale.ROOT);
        if (uid.equals(full)) return true;
        return !learnedSuffix(observed, base).isEmpty() && Prefs.load(ctx).carrierId.equals("auto");
    }

    private String learnedSuffix(String observed, String base) {
        if (observed == null || base == null || observed.length() <= base.length()
                || !observed.regionMatches(true, 0, base, 0, base.length())) return "";
        String suffix = observed.substring(base.length());
        return suffix.matches("@[A-Za-z0-9._-]+") ? suffix : "";
    }

    private static String nowTime() {
        return new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.CHINA).format(new java.util.Date());
    }

    private void notifyUser(String title, String msg) {
        if (listener != null) handler.post(() -> listener.onNotify(title, msg));
    }

    // ---------------- 协议层 ----------------
    private static class ProbeResult {
        boolean online; String uid; String ip; long oltime;
    }
    private static class LoginResult {
        boolean ok; String msg; String ip; JSONObject raw;
    }

    // JS encodeURIComponent 等价实现（URLEncoder 差异修正：+→%20，还原 ! ' ( ) ~）
    // 注意：@ 会被编码为 %40，与浏览器 jQuery $.param 行为一致（实测内核可正常解码）
    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8")
                    .replace("+", "%20")
                    .replace("%21", "!")
                    .replace("%27", "'")
                    .replace("%28", "(")
                    .replace("%29", ")")
                    .replace("%7E", "~");
        } catch (Exception e) {
            return s;
        }
    }

    // 本机校园网侧 IPv4（wlan_user_ip 需要；排除环回/链路本地/虚拟网卡）
    public static String localIp() {
        String bad = "^(127\\.|169\\.254\\.|26\\.|198\\.18\\.|100\\.)";
        String fallback = "";
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (Exception ignored) { continue; }
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    String ip = a.getHostAddress();
                    if (ip.matches(bad)) continue;
                    if (ip.startsWith("172.19.")) return ip; // 校园网网段优先
                    if (fallback.isEmpty()) fallback = ip;
                }
            }
        } catch (Exception ignored) { }
        return fallback;
    }

    // URL 构建：callback 必须第一、lang 最后（Dr.COM 老内核对参数顺序敏感，顺序错误返回 400）
    private String buildUrl(String path, String callback, LinkedHashMap<String, String> mids, String lang, int port) {
        String host = host();
        StringBuilder sb = new StringBuilder("http://").append(host).append(':').append(port).append(path)
                .append("?callback=").append(enc(callback));
        for (Map.Entry<String, String> e : mids.entrySet()) {
            sb.append('&').append(enc(e.getKey())).append('=').append(enc(e.getValue() == null ? "" : e.getValue()));
        }
        sb.append("&lang=").append(enc(lang));
        return sb.toString();
    }

    private static String httpGet(String url) throws Exception {
        URL requestUrl = new URL(url);
        HttpURLConnection conn = (HttpURLConnection) requestUrl.openConnection();
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setRequestMethod("GET");
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
        conn.setRequestProperty("Referer", "http://" + requestUrl.getHost() + "/");
        conn.setRequestProperty("Accept", "*/*");
        try {
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) throw new Exception("HTTP " + code);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toString("UTF-8");
        } finally {
            conn.disconnect();
        }
    }

    // JSONP：jQuery123({...}) → 提取 {...}
    private static JSONObject jsonpParse(String body) throws Exception {
        int s = body.indexOf('('), e = body.lastIndexOf(')');
        if (s < 0 || e <= s) throw new Exception("非 JSONP 响应: " + body.substring(0, Math.min(120, body.length())));
        return new JSONObject(body.substring(s + 1, e));
    }

    // 在线状态探测：null = 门户不可达
    public ProbeResult chkstatus() {
        try {
            LinkedHashMap<String, String> mids = new LinkedHashMap<>();
            mids.put("v", String.valueOf(System.currentTimeMillis() + (long) (Math.random() * 1000)));
            String url = buildUrl("/drcom/chkstatus", "jQuery" + (long) (Math.random() * 1e9), mids, "zh", 80);
            JSONObject j = jsonpParse(httpGet(url));
            ProbeResult r = new ProbeResult();
            r.online = j.optInt("result") == 1;
            r.uid = j.optString("uid", "");
            r.ip = j.optString("v46ip", "");
            r.oltime = j.optLong("oltime", 0);
            return r;
        } catch (Exception e) {
            return null;
        }
    }

    // eportal/portal/login 标准参数集：user_account/user_password 为【明文】（后端不做 base64 解码，已实测排除）
    public LoginResult login(String account, String password) {
        try {
            LinkedHashMap<String, String> mids = new LinkedHashMap<>();
            mids.put("login_method", "1");
            mids.put("user_account", account);
            mids.put("user_password", password);
            mids.put("wlan_user_ip", localIp());
            mids.put("wlan_user_ipv6", "");
            mids.put("wlan_user_mac", "000000000000");
            mids.put("wlan_ac_ip", "");
            mids.put("wlan_ac_name", "");
            mids.put("jsVersion", "4.1.3");
            mids.put("terminal_type", "1");
            mids.put("v", String.valueOf(System.currentTimeMillis() + (long) (Math.random() * 1000)));
            String url = buildUrl("/eportal/portal/login", "dr1003", mids, "zh-cn", 801);
            JSONObject j = jsonpParse(httpGet(url));
            LoginResult r = new LoginResult();
            r.raw = j;
            r.ok = j.optInt("result") == 1;
            r.msg = r.ok ? "" : j.optString("msg", "未知错误");
            r.ip = localIp();
            return r;
        } catch (Exception e) {
            LoginResult r = new LoginResult();
            r.ok = false;
            r.msg = "NETWORK: " + e.getMessage();
            return r;
        }
    }

    // 注销：eportal 标准 logout，同源同端口，无需凭据。返回 null = 网络失败
    public static String logout(Context ctx) {
        try {
            LinkedHashMap<String, String> mids = new LinkedHashMap<>();
            mids.put("v", String.valueOf(System.currentTimeMillis()));
            PortalEngine dummy = new PortalEngine(ctx, null);
            String url = dummy.buildUrl("/eportal/portal/logout", "dr1003", mids, "zh-cn", 801);
            JSONObject j = jsonpParse(httpGet(url));
            return j.optInt("result") == 1 ? "" : j.optString("msg", "未知错误");
        } catch (Exception e) {
            return null;
        }
    }
}
