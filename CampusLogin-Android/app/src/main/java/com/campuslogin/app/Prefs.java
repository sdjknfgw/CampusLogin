// 配置读写：SharedPreferences 持久化（对应 PC 端 settings.js 的逻辑）
// 运营商后缀解析 / 账号组合 / 日志环形缓冲（最近 100 条）
package com.campuslogin.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiInfo;
import android.net.DhcpInfo;

import org.json.JSONArray;
import org.json.JSONObject;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class Prefs {
    private static final String PASSWORD_KEY = "password_enc_v1";
    private static final String KEY_ALIAS = "CampusLoginPassword";
    // 运营商选项（与 PC 端 CARRIER_OPTIONS 一致 + 校内实测补充 @cmcc）
    public static final String[][] CARRIER_OPTIONS = {
            { "auto",   "自动检测（从在线账号学习）" },
            { "campus", "校园用户（无后缀）" },
            { "cmcc",   "中国移动 @cmcc" },
            { "dx",     "校园电信 @dx" },
            { "lt",     "校园联通 @lt" },
            { "custom", "自定义后缀" }
    };

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences("settings", Context.MODE_PRIVATE);
    }

    public static class Config {
        public String account = "";
        public String password = "";
        public String portalHost = "172.19.0.1";
        public String carrierId = "campus";
        public String customSuffix = "";
        public boolean autoLogin = true;
        public boolean bootStart = false;
        public String learnedSuffix = "";
        public String learnedAccount = "";
    }

    public static Config load(Context c) {
        SharedPreferences p = sp(c);
        Config s = new Config();
        s.account = p.getString("account", "");
        String encrypted = p.getString(PASSWORD_KEY, "");
        if (!encrypted.isEmpty()) {
            try { s.password = decryptPassword(encrypted); } catch (Exception ignored) { s.password = ""; }
        } else {
            String legacy = p.getString("password", "");
            if (!legacy.isEmpty()) {
                try { p.edit().putString(PASSWORD_KEY, encryptPassword(legacy)).remove("password").apply(); s.password = legacy; }
                catch (Exception ignored) { s.password = ""; }
            }
        }
        s.portalHost = p.getString("portalHost", "172.19.0.1");
        s.carrierId = p.getString("carrierId", "campus");
        s.customSuffix = p.getString("customSuffix", "");
        s.autoLogin = p.getBoolean("autoLogin", true);
        s.bootStart = p.getBoolean("bootStart", false);
        s.learnedSuffix = p.getString("learnedSuffix", "");
        s.learnedAccount = p.getString("learnedAccount", "");
        return s;
    }

    public static void save(Context c, Config s) {
        SharedPreferences.Editor edit = sp(c).edit()
                .putString("account", s.account)
                .putString("portalHost", s.portalHost)
                .putString("carrierId", s.carrierId)
                .putString("customSuffix", s.customSuffix)
                .putBoolean("autoLogin", s.autoLogin)
                .putBoolean("bootStart", s.bootStart)
                .putString("learnedSuffix", s.learnedSuffix)
                .putString("learnedAccount", s.learnedAccount);
        try {
            if (s.password == null || s.password.isEmpty()) edit.remove(PASSWORD_KEY);
            else edit.putString(PASSWORD_KEY, encryptPassword(s.password));
        } catch (Exception e) { throw new IllegalStateException("无法安全保存密码", e); }
        edit.remove("password").apply();
    }

    private static SecretKey passwordKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        java.security.Key existing = store.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private static String encryptPassword(String password) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, passwordKey());
        byte[] iv = cipher.getIV(), ciphertext = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
        ByteBuffer payload = ByteBuffer.allocate(1 + iv.length + ciphertext.length); payload.put((byte) iv.length).put(iv).put(ciphertext);
        return Base64.encodeToString(payload.array(), Base64.NO_WRAP);
    }
    private static String decryptPassword(String encoded) throws Exception {
        ByteBuffer buffer = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP)); int ivLength = buffer.get() & 0xff;
        if (ivLength == 0 || ivLength > 32 || buffer.remaining() <= ivLength) throw new IllegalArgumentException("Bad password payload");
        byte[] iv = new byte[ivLength]; buffer.get(iv); byte[] ciphertext = new byte[buffer.remaining()]; buffer.get(ciphertext);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, passwordKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    public static class NetworkInfo {
        public final String gateway;
        public final String ssid;
        NetworkInfo(String gateway, String ssid) { this.gateway = gateway; this.ssid = ssid; }
        public String key() { return gateway + "|" + ssid.toLowerCase(java.util.Locale.ROOT); }
    }

    public static NetworkInfo currentNetwork(Context c) {
        String gateway = "", ssid = "";
        try {
            WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                DhcpInfo dhcp = wm.getDhcpInfo();
                if (dhcp != null && dhcp.gateway != 0) {
                    int ip = dhcp.gateway;
                    gateway = (ip & 0xff) + "." + ((ip >> 8) & 0xff) + "." + ((ip >> 16) & 0xff) + "." + ((ip >> 24) & 0xff);
                }
                WifiInfo info = wm.getConnectionInfo();
                if (info != null) {
                    ssid = info.getSSID();
                    if (ssid != null) {
                        ssid = ssid.replace("\"", "");
                        if (ssid.startsWith("<") || ssid.equalsIgnoreCase("unknown ssid")) ssid = "";
                    } else ssid = "";
                }
            }
        } catch (Exception ignored) { }
        return new NetworkInfo(gateway, ssid);
    }

    public static void savePortalProfile(Context c, String host) {
        SharedPreferences p = sp(c);
        NetworkInfo net = currentNetwork(c);
        JSONArray all;
        try { all = new JSONArray(p.getString("portalProfiles", "[]")); }
        catch (Exception e) { all = new JSONArray(); }
        String id = net.key() + "|" + host;
        boolean collision = false;
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            if (item == null || !net.key().equals(item.optString("networkKey"))) continue;
            if (!host.equals(item.optString("host"))) collision = true;
        }
        boolean exists = false;
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            if (item != null && id.equals(item.optString("id"))) exists = true;
        }
        if (!exists) {
            JSONObject item = new JSONObject();
            try {
                item.put("id", id); item.put("networkKey", net.key());
                item.put("gateway", net.gateway); item.put("ssid", net.ssid); item.put("host", host);
                all.put(item);
            } catch (Exception ignored) { }
        }
        SharedPreferences.Editor edit = p.edit().putString("portalProfiles", all.toString());
        edit.putString("selectedPortalProfile", collision ? "" : id);
        edit.putString("portalHost", host).apply();
    }

    public static JSONArray portalCandidates(Context c) {
        JSONArray all;
        try { all = new JSONArray(sp(c).getString("portalProfiles", "[]")); }
        catch (Exception e) { return new JSONArray(); }
        NetworkInfo net = currentNetwork(c);
        JSONArray matched = new JSONArray();
        int best = 0;
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            if (item == null) continue;
            boolean gw = !net.gateway.isEmpty() && net.gateway.equals(item.optString("gateway"));
            boolean ss = !net.ssid.isEmpty() && net.ssid.equalsIgnoreCase(item.optString("ssid"));
            int score = (gw ? 100 : 0) + (ss ? 10 : 0);
            if (score == 0) continue;
            if (score > best) { matched = new JSONArray(); best = score; }
            if (score == best) matched.put(item);
        }
        return matched;
    }

    public static boolean hasPortalProfiles(Context c) {
        try { return new JSONArray(sp(c).getString("portalProfiles", "[]")).length() > 0; }
        catch (Exception e) { return false; }
    }

    public static String selectedPortalHost(Context c) {
        // CampusLogin stores one set of credentials for this school. Reuse the
        // last confirmed portal across Wi-Fi networks instead of requiring a
        // profile match or selection every time the network changes.
        String global = load(c).portalHost;
        return global == null ? "" : global;
    }

    public static String editorPortalHost(Context c) {
        String matched = selectedPortalHost(c);
        return matched.isEmpty() ? load(c).portalHost : matched;
    }

    public static void selectPortalProfile(Context c, JSONObject item) {
        if (item == null) return;
        sp(c).edit().putString("selectedPortalProfile", item.optString("id"))
                .putString("portalHost", item.optString("host")).apply();
    }

    // 后缀自动学习（auto 模式核心：从 chkstatus uid 学到）
    public static void setLearned(Context c, String suffix, String fullUid) {
        SharedPreferences p = sp(c);
        if (suffix.equals(p.getString("learnedSuffix", "")) && fullUid.equals(p.getString("learnedAccount", ""))) return;
        p.edit().putString("learnedSuffix", suffix).putString("learnedAccount", fullUid).apply();
        pushLog(c, "info", "自动学习运营商后缀: " + (suffix.isEmpty() ? "(无)" : suffix) + "（来自在线账号 " + fullUid + "）");
    }

    public static String resolveSuffix(Context c) {
        Config s = load(c);
        switch (s.carrierId) {
            case "auto":   return s.learnedSuffix == null ? "" : s.learnedSuffix;
            case "custom": return s.customSuffix == null ? "" : s.customSuffix;
            case "cmcc":   return "@cmcc";
            case "dx":     return "@dx";
            case "lt":     return "@lt";
            default:       return ""; // campus
        }
    }

    // 组合完整登录账号：学号 + 后缀（去重：已手输后缀则不重复拼）
    public static String fullAccount(Context c) {
        Config s = load(c);
        String suffix = resolveSuffix(c);
        if (suffix.isEmpty()) return s.account;
        return s.account.toLowerCase().endsWith(suffix.toLowerCase()) ? s.account : s.account + suffix;
    }

    // ---- 日志（最近 100 条，JSON 数组持久化）----
    public static void pushLog(Context c, String level, String msg) {
        try {
            JSONArray arr = new JSONArray(sp(c).getString("logs", "[]"));
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis());
            o.put("l", level);
            o.put("m", msg);
            JSONArray next = new JSONArray();
            next.put(o);
            for (int i = 0; i < arr.length() && i < 99; i++) next.put(arr.get(i));
            sp(c).edit().putString("logs", next.toString()).apply();
        } catch (Exception ignored) { }
    }

    public static JSONArray getLogs(Context c) {
        try {
            return new JSONArray(sp(c).getString("logs", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }
}
