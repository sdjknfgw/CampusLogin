// 前台服务：常驻协议引擎（心跳 45~75s）+ 网络变化即时触发 + 状态常驻通知
package com.campuslogin.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.IBinder;

public class LoginService extends Service {
    private static final String CHANNEL_STATUS = "status";
    private static final String CHANNEL_ALERTS = "alerts";
    private static final int NOTIF_ID = 1001;

    private static volatile boolean running = false;
    private PortalEngine engine;
    private ConnectivityManager.NetworkCallback netCallback;

    public static boolean isRunning() { return running; }

    public static PortalEngine.Snapshot snapshot() {
        LoginService s = instance;
        return s != null && s.engine != null ? s.engine.getSnapshot() : null;
    }

    public static void triggerNow(Context c) {
        LoginService s = instance;
        if (s != null && s.engine != null) s.engine.triggerNow("manual");
    }

    private static LoginService instance;

    public static void start(Context c) {
        Context app = c.getApplicationContext();
        Intent i = new Intent(app, LoginService.class);
        if (android.os.Build.VERSION.SDK_INT >= 26) app.startForegroundService(i);
        else app.startService(i);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIF_ID, buildNotification("启动中…"));

        if (engine == null) {
            engine = new PortalEngine(this, new PortalEngine.Listener() {
                @Override
                public void onStateChanged(PortalEngine.Snapshot s) {
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    nm.notify(NOTIF_ID, buildNotification(describe(s)));
                }

                @Override
                public void onNotify(String title, String msg) {
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    Notification n = new Notification.Builder(LoginService.this, CHANNEL_ALERTS)
                            .setSmallIcon(R.drawable.ic_stat_notify)
                            .setContentTitle(title)
                            .setContentText(msg)
                            .setStyle(new Notification.BigTextStyle().bigText(msg))
                            .setAutoCancel(true)
                            .build();
                    nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), n);
                }
            });
            engine.start();
            registerNetworkCallback();
        }
        running = true;
        return START_STICKY;
    }

    private void registerNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    PortalEngine e = engine;
                    if (e != null) e.triggerNow("network");
                }
            };
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (Exception ignored) { }
    }

    @Override
    public void onDestroy() {
        try {
            if (netCallback != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                cm.unregisterNetworkCallback(netCallback);
                netCallback = null;
            }
        } catch (Exception ignored) { }
        if (engine != null) { engine.stop(); engine = null; }
        running = false;
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private static String describe(PortalEngine.Snapshot s) {
        if (s == null) return "启动中…";
        switch (s.state) {
            case "online":  return "在线 " + s.fullAccount + (s.oltime > 0 ? " · " + fmtTime(s.oltime) : "");
            case "busy":    return "登录中…";
            case "offline": return "未认证（" + s.msg + "）";
            case "error":   return "已停止: " + s.msg;
            default:        return s.msg == null || s.msg.isEmpty() ? "待机" : s.msg;
        }
    }

    private static String fmtTime(long sec) {
        long h = sec / 3600, m = (sec % 3600) / 60, ss = sec % 60;
        return h > 0 ? String.format(java.util.Locale.CHINA, "%dh%02dm", h, m)
                : String.format(java.util.Locale.CHINA, "%dm%02ds", m, ss);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_STATUS)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle("校园网自动登录")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private static void createChannels(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_STATUS, "运行状态", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ALERTS, "登录结果提醒", NotificationManager.IMPORTANCE_DEFAULT));
    }
}
