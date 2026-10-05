package com.campuslogin.app;

import android.content.Context;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Read-only, on-demand campus-portal discovery. No browser requests are captured. */
public final class PortalDiscovery {
    public interface Callback { void onComplete(String host); }
    private static final long TIMEOUT_MS = 120_000L;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private PortalDiscovery() { }

    public static void find(Context context, String gateway, Callback callback) {
        EXECUTOR.execute(() -> {
            long deadline = System.currentTimeMillis() + TIMEOUT_MS;
            while (System.currentTimeMillis() < deadline) {
                if (isDrcomGateway(gateway)) { callback.onComplete(gateway); return; }
                try { Thread.sleep(3_000L); } catch (InterruptedException ignored) { break; }
            }
            callback.onComplete(null);
        });
    }

    private static boolean isDrcomGateway(String host) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("http://" + host + "/drcom/chkstatus?callback=portalDiscovery&v=" + System.currentTimeMillis());
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "*/*");
            int code = conn.getResponseCode();
            return code >= 200 && code < 400;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
