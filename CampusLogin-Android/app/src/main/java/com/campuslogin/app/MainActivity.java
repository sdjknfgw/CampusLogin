// 主界面：状态卡 + 账号配置 + 引擎控制 + 日志（赛博暗色风）
package com.campuslogin.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.ScrollView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

public class MainActivity extends Activity {
    // 与 strings.xml carrier_labels 顺序一致
    private static final String[] CARRIER_IDS = { "auto", "campus", "cmcc", "dx", "lt", "custom" };

    private EditText etAccount, etPassword, etCustomSuffix, etPortalHost;
    private Spinner spCarrier;
    private Switch swAutoLogin, swBootStart;
    private TextView tvState, tvAccount, tvInfo, tvSuffixHint, tvEngineState, tvLog, tvNetworkProfile;
    private Button btnStart, btnStop;

    private static final int REQUEST_PORTAL_BROWSER = 410;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean suppressSpinner = false;
    private String promptedNetworkKey = "";

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            refreshStatus();
            ui.postDelayed(this, 800);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        etAccount = findViewById(R.id.etAccount);
        etPassword = findViewById(R.id.etPassword);
        etCustomSuffix = findViewById(R.id.etCustomSuffix);
        etPortalHost = findViewById(R.id.etPortalHost);
        spCarrier = findViewById(R.id.spCarrier);
        swAutoLogin = findViewById(R.id.swAutoLogin);
        swBootStart = findViewById(R.id.swBootStart);
        tvState = findViewById(R.id.tvState);
        tvAccount = findViewById(R.id.tvAccount);
        tvInfo = findViewById(R.id.tvInfo);
        tvSuffixHint = findViewById(R.id.tvSuffixHint);
        tvEngineState = findViewById(R.id.tvEngineState);
        tvLog = findViewById(R.id.tvLog);
        tvNetworkProfile = findViewById(R.id.tvNetworkProfile);
        btnStart = findViewById(R.id.btnStart);
        btnStop = findViewById(R.id.btnStop);

        ArrayAdapter<CharSequence> ad = ArrayAdapter.createFromResource(this,
                R.array.carrier_labels, android.R.layout.simple_spinner_item);
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spCarrier.setAdapter(ad);
        spCarrier.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> p, View v, int pos, long id) {
                if (suppressSpinner) return;
                etCustomSuffix.setVisibility(CARRIER_IDS[pos].equals("custom") ? View.VISIBLE : View.GONE);
            }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });

        loadConfigToUi();

        findViewById(R.id.btnSave).setOnClickListener(v -> onSave());
        btnStart.setOnClickListener(v -> LoginService.start(this));
        btnStop.setOnClickListener(v -> stopService(new Intent(this, LoginService.class)));
        findViewById(R.id.btnLoginNow).setOnClickListener(v -> onLoginNow());
        findViewById(R.id.btnLogout).setOnClickListener(v -> onLogout());
        findViewById(R.id.btnCheckUpdates).setOnClickListener(v -> checkForUpdates());
        findViewById(R.id.btnDiscoverPortal).setOnClickListener(v -> showPortalDiscoveryIntro());

        swAutoLogin.setOnCheckedChangeListener((b, on) -> updatePrefs(s -> s.autoLogin = on));
        swBootStart.setOnCheckedChangeListener((b, on) -> updatePrefs(s -> s.bootStart = on));

        java.util.ArrayList<String> permissions = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if (!permissions.isEmpty()) requestPermissions(permissions.toArray(new String[0]), 1);
    }

    /**
     * Android does not expose another browser's HTTPS requests or page title to an app.
     * The discovery flow therefore opens only the current Wi-Fi gateway in the user's
     * browser and, while the two-minute session is active, performs read-only Dr.COM
     * status checks against that gateway.  It never installs a VPN or reads browser data.
     */
    private void showPortalDiscoveryIntro() {
        new AlertDialog.Builder(this)
                .setTitle("自动检测校园网门户")
                .setMessage("接下来会打开浏览器。请在“常州工学院”校园网页面正常登录一次。\n\n检测只持续 2 分钟，只验证当前 Wi-Fi 网关是否为校园网门户；不会读取、保存或上传网页内容、账号或密码。")
                .setNegativeButton("取消", null)
                .setPositiveButton("开始检测", (d, w) -> beginPortalDiscovery())
                .show();
    }

    private void beginPortalDiscovery() {
        Prefs.NetworkInfo net = Prefs.currentNetwork(this);
        if (net.gateway.isEmpty()) {
            toast("未找到 Wi-Fi 网关，请先连接校园网");
            return;
        }
        findViewById(R.id.btnDiscoverPortal).setEnabled(false);
        ((Button) findViewById(R.id.btnDiscoverPortal)).setText("正在检测（最多 2 分钟）");
        PortalDiscovery.find(this, net.gateway, result -> runOnUiThread(() -> {
            Button button = findViewById(R.id.btnDiscoverPortal);
            button.setEnabled(true);
            button.setText("自动检测校园网门户");
            if (result == null || !isValidHost(result)) {
                new AlertDialog.Builder(this).setTitle("未找到校园网门户")
                        .setMessage("请确认已在手机浏览器中完成常州工学院校园网登录，再重新检测。")
                        .setPositiveButton("重新检测", (d, w) -> beginPortalDiscovery())
                        .setNegativeButton("保留原门户", null).show();
                return;
            }
            new AlertDialog.Builder(this).setTitle("发现校园网门户")
                    .setMessage("已发现校园网门户：" + result + "\n\n是否使用此门户进行自动登录？")
                    .setPositiveButton("使用此门户", (d, w) -> acceptDiscoveredPortal(result))
                    .setNegativeButton("保留原门户", null)
                    .setNeutralButton("重新检测", (d, w) -> beginPortalDiscovery()).show();
        }));
        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse("http://" + net.gateway + "/"));
            startActivityForResult(browser, REQUEST_PORTAL_BROWSER);
        } catch (Exception e) {
            toast("无法打开浏览器，请手动打开校园网登录页");
        }
    }

    private void acceptDiscoveredPortal(String host) {
        etPortalHost.setText(host);
        Prefs.Config s = Prefs.load(this);
        s.portalHost = host;
        Prefs.save(this, s);
        Prefs.savePortalProfile(this, host);
        Prefs.pushLog(this, "info", "已采用自动发现的校园网门户：" + host);
        toast("已使用校园网门户");
        refreshStatus();
    }

    // ---- 配置 ----
    private void loadConfigToUi() {
        Prefs.Config s = Prefs.load(this);
        etAccount.setText(s.account);
        etPassword.setText(s.password);
        etPortalHost.setText(Prefs.editorPortalHost(this));
        etCustomSuffix.setText(s.customSuffix);
        suppressSpinner = true;
        for (int i = 0; i < CARRIER_IDS.length; i++) {
            if (CARRIER_IDS[i].equals(s.carrierId)) spCarrier.setSelection(i);
        }
        suppressSpinner = false;
        etCustomSuffix.setVisibility(s.carrierId.equals("custom") ? View.VISIBLE : View.GONE);
        updateNetworkLabel();
        swAutoLogin.setChecked(s.autoLogin);
        swBootStart.setChecked(s.bootStart);
    }

    private void onSave() {
        String account = etAccount.getText().toString().trim();
        String password = etPassword.getText().toString();
        String portalHost = etPortalHost.getText().toString().trim();
        if (account.isEmpty()) { toast("请输入学号"); return; }
        if (password.isEmpty()) { toast("密码不能为空，请输入校园网密码"); return; }
        if (!isValidHost(portalHost)) { toast("请输入有效的门户 IPv4 地址"); return; }
        Prefs.Config s = Prefs.load(this);
        s.account = account;
        s.password = password;
        s.portalHost = portalHost;
        s.carrierId = CARRIER_IDS[spCarrier.getSelectedItemPosition()];
        s.customSuffix = etCustomSuffix.getText().toString().trim();
        Prefs.save(this, s);
        Prefs.savePortalProfile(this, portalHost);
        Prefs.pushLog(this, "info", "配置已保存（账号 " + Prefs.fullAccount(this) + "）");
        toast("配置已保存");
        refreshStatus();
        if (LoginService.isRunning()) LoginService.triggerNow(this);
    }

    private void updatePrefs(java.util.function.Consumer<Prefs.Config> fn) {
        Prefs.Config s = Prefs.load(this);
        fn.accept(s);
        Prefs.save(this, s);
    }

    // ---- 动作 ----
    private void onLoginNow() {
        Prefs.Config s = Prefs.load(this);
        if (s.account.isEmpty() || s.password.isEmpty()) { toast("请先填写学号与密码并保存"); return; }
        if (!LoginService.isRunning()) LoginService.start(this);
        ui.postDelayed(() -> {
            if (LoginService.isRunning()) LoginService.triggerNow(this);
        }, 600);
    }

    private void onLogout() {
        toast("正在注销…");
        new Thread(() -> {
            String r = PortalEngine.logout(this);
            if (r == null) Prefs.pushLog(this, "warn", "注销失败: 网络不可达");
            else if (r.isEmpty()) Prefs.pushLog(this, "info", "已注销下线");
            else Prefs.pushLog(this, "warn", "注销返回: " + r);
            runOnUiThread(() -> {
                toast(r == null ? "注销失败: 网络不可达" : (r.isEmpty() ? "已注销下线" : "注销返回: " + r));
                refreshStatus();
            });
        }, "logout").start();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    // ---- 状态轮询 ----
    private void refreshStatus() {
        updateNetworkLabel();
        maybePromptNetworkProfile();
        boolean running = LoginService.isRunning();
        tvEngineState.setText(running ? "引擎运行中" : "引擎未运行");
        tvEngineState.setTextColor(running ? getCol(R.color.ok) : getCol(R.color.muted));
        btnStart.setEnabled(!running);
        btnStop.setEnabled(running);
        btnStart.setAlpha(running ? 0.4f : 1f);
        btnStop.setAlpha(running ? 1f : 0.4f);

        PortalEngine.Snapshot snap = LoginService.snapshot();
        if (snap != null) {
            int color;
            String label;
            switch (snap.state) {
                case "online":  color = R.color.ok;    label = "在线"; break;
                case "busy":    color = R.color.busy;  label = "登录中…"; break;
                case "offline": color = R.color.busy;  label = "未认证"; break;
                case "error":   color = R.color.err;   label = "已停止"; break;
                default:        color = R.color.muted; label = "待机"; break;
            }
            tvState.setText(label + (snap.msg == null || snap.msg.isEmpty() ? "" : " · " + snap.msg));
            tvState.setTextColor(getCol(color));
            tvAccount.setText("账号: " + (snap.fullAccount == null || snap.fullAccount.isEmpty() ? "—" : snap.fullAccount));
            String info = "IP: " + (snap.ip == null || snap.ip.isEmpty() ? "—" : snap.ip);
            if (snap.state.equals("online") && snap.oltime > 0) info += " · 在线 " + fmtTime(snap.oltime);
            if (snap.uid != null && !snap.uid.isEmpty() && !snap.uid.equals(snap.fullAccount)) info += " · 在线账号 " + snap.uid;
            tvInfo.setText(info);
        } else {
            tvState.setText("待机");
            tvState.setTextColor(getCol(R.color.muted));
            tvAccount.setText("账号: —");
            tvInfo.setText("IP: —");
        }

        // 后缀提示
        Prefs.Config cfg = Prefs.load(this);
        String suffix = Prefs.resolveSuffix(this);
        String hint;
        if (cfg.carrierId.equals("auto")) {
            hint = "自动检测模式 · 当前后缀: " + (suffix.isEmpty() ? "(尚未学习)" : suffix)
                    + (cfg.learnedAccount.isEmpty() ? "" : " · 学习自 " + cfg.learnedAccount);
        } else {
            hint = "运营商后缀: " + (suffix.isEmpty() ? "(无)" : suffix);
        }
        tvSuffixHint.setText(hint);

        // 日志（最近 20 条）
        JSONArray logs = Prefs.getLogs(this);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < logs.length() && i < 20; i++) {
            JSONObject o = logs.optJSONObject(i);
            if (o == null) continue;
            sb.append("[").append(fmtClock(o.optLong("t"))).append("] ")
              .append(o.optString("l")).append(" ").append(o.optString("m")).append('\n');
        }
        tvLog.setText(sb.length() == 0 ? "—" : sb.toString().trim());
    }

    private void updateNetworkLabel() {
        if (tvNetworkProfile == null) return;
        Prefs.NetworkInfo net = Prefs.currentNetwork(this);
        tvNetworkProfile.setText("当前网络 · 网关 " + (net.gateway.isEmpty() ? "未知" : net.gateway)
                + (net.ssid.isEmpty() ? "" : " · Wi-Fi " + net.ssid));
    }

    private void maybePromptNetworkProfile() {
        if (isFinishing()) return;
        Prefs.NetworkInfo net = Prefs.currentNetwork(this);
        if (net.gateway.isEmpty() && net.ssid.isEmpty()) return;
        String key = net.key();
        if (key.equals(promptedNetworkKey)) return;
        org.json.JSONArray candidates = Prefs.portalCandidates(this);
        String selected = Prefs.selectedPortalHost(this);
        if (candidates.length() > 1 && selected.isEmpty()) {
            promptedNetworkKey = key;
            String[] labels = new String[candidates.length()];
            for (int i = 0; i < candidates.length(); i++) {
                org.json.JSONObject p = candidates.optJSONObject(i);
                labels[i] = p == null ? "门户" : p.optString("ssid", "校园网") + " · " + p.optString("host");
            }
            new AlertDialog.Builder(this).setTitle("选择当前校园网门户")
                    .setItems(labels, (dialog, which) -> {
                        Prefs.selectPortalProfile(this, candidates.optJSONObject(which));
                        etPortalHost.setText(Prefs.selectedPortalHost(this));
                        promptedNetworkKey = "";
                        LoginService.triggerNow(this);
                        toast("已选择当前门户");
                    }).setOnCancelListener(d -> toast("尚未选择门户，自动登录暂停")).show();
        } else if (candidates.length() == 0 && Prefs.hasPortalProfiles(this)) {
            promptedNetworkKey = key;
            EditText input = new EditText(this);
            input.setSingleLine(true);
            input.setHint("门户 IP，例如 10.0.0.1");
            new AlertDialog.Builder(this).setTitle("发现新网络")
                    .setMessage("输入此校园网的门户 IP，保存后会按当前网关和 Wi-Fi 自动识别。")
                    .setView(input).setPositiveButton("保存网络", (d, which) -> {
                        String host = input.getText().toString().trim();
                        if (!isValidHost(host)) { promptedNetworkKey = ""; toast("门户 IP 无效"); return; }
                        etPortalHost.setText(host);
                        onSave();
                    }).setNegativeButton("稍后", (d, which) -> { }).show();
        }
    }

    private static boolean isValidHost(String host) {
        if (host == null || !host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false;
        for (String part : host.split("\\.")) {
            try { if (Integer.parseInt(part) > 255) return false; }
            catch (NumberFormatException e) { return false; }
        }
        return true;
    }

    private void checkForUpdates() {
        Button button = findViewById(R.id.btnCheckUpdates);
        button.setEnabled(false);
        button.setText("正在检查…");
        new Thread(() -> {
            try {
                java.net.URL url = new java.net.URL("https://api.github.com/repos/sdjknfgw/CampusLogin/releases/latest");
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setRequestProperty("User-Agent", "CampusLogin-Updater-Android");
                try {
                    int status = conn.getResponseCode();
                    if (status != 200) throw new Exception("GitHub 返回 HTTP " + status);
                    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                    try (java.io.InputStream in = conn.getInputStream()) {
                        byte[] buffer = new byte[4096];
                        int n;
                        while ((n = in.read(buffer)) != -1) bytes.write(buffer, 0, n);
                    }
                    JSONObject release = new JSONObject(bytes.toString("UTF-8"));
                    String latest = release.optString("tag_name", release.optString("name", "")).replaceFirst("^[vV]", "");
                    String notes = release.optString("body", "此版本没有提供更新说明。");
                    String releaseUrl = release.optString("html_url", "https://github.com/sdjknfgw/CampusLogin/releases/latest");
                    String current = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                    boolean available = compareVersions(latest, current) > 0;
                    runOnUiThread(() -> {
                        if (available) showUpdateDialog(current, latest, notes, releaseUrl);
                        else toast("当前已是最新版 v" + current);
                    });
                } finally { conn.disconnect(); }
            } catch (Exception e) {
                runOnUiThread(() -> toast("检查更新失败：" + (e.getMessage() == null ? "网络错误" : e.getMessage())));
            } finally {
                runOnUiThread(() -> { button.setEnabled(true); button.setText("检查更新"); });
            }
        }, "check-updates").start();
    }

    private void showUpdateDialog(String current, String latest, String notes, String releaseUrl) {
        TextView content = new TextView(this);
        content.setText("当前版本 v" + current + "  →  最新版本 v" + latest + "\n\n" + notes);
        content.setTextColor(getCol(R.color.text));
        content.setTextSize(14);
        content.setPadding(20, 12, 20, 12);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        new AlertDialog.Builder(this)
                .setTitle("发现新版本")
                .setView(scroll)
                .setNegativeButton("稍后", null)
                .setPositiveButton("打开下载页面", (dialog, which) -> {
                    Uri uri = Uri.parse(releaseUrl);
                    if ("https".equals(uri.getScheme()) && "github.com".equalsIgnoreCase(uri.getHost())) {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } else toast("下载地址无效");
                }).show();
    }

    private static int compareVersions(String a, String b) {
        String[] left = a.replaceFirst("^[vV]", "").split("[.+-]");
        String[] right = b.replaceFirst("^[vV]", "").split("[.+-]");
        for (int i = 0; i < 3; i++) {
            int x = i < left.length ? parseVersionPart(left[i]) : 0;
            int y = i < right.length ? parseVersionPart(right[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }

    private static int parseVersionPart(String value) {
        try { return Integer.parseInt(value); }
        catch (NumberFormatException e) { return 0; }
    }

    private static String fmtTime(long sec) {
        long h = sec / 3600, m = (sec % 3600) / 60, s = sec % 60;
        return h > 0 ? String.format(Locale.CHINA, "%dh%02dm", h, m)
                : String.format(Locale.CHINA, "%dm%02ds", m, s);
    }

    private static String fmtClock(long ts) {
        return new java.text.SimpleDateFormat("HH:mm:ss", Locale.CHINA).format(new java.util.Date(ts));
    }

    private int getCol(int id) {
        return getResources().getColor(id, getTheme());
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatus();
        ui.postDelayed(poll, 800);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(poll);
    }
}
