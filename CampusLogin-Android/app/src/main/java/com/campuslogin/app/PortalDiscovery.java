package com.campuslogin.app;

import android.content.Context;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.ArrayList;
import java.util.List;

/** Read-only, on-demand campus-portal discovery. No browser requests are captured. */
public final class PortalDiscovery {
    public interface Callback { void onComplete(String host); }
    private static final String CAMPUS_PORTAL_HOST = "172.19.0.1";
    private static final long TIMEOUT_MS = 120_000L;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private PortalDiscovery() { }

    public static void find(Context context, String gateway, Callback callback) {
        EXECUTOR.execute(() -> {
            long deadline = System.currentTimeMillis() + TIMEOUT_MS;
            List<String> candidates = candidates(gateway);
            while (System.currentTimeMillis() < deadline) {
                for (String candidate : candidates) {
                    if (isDrcomGateway(candidate)) { callback.onComplete(candidate); return; }
                }
                try { Thread.sleep(3_000L); } catch (InterruptedException ignored) { break; }
            }
            callback.onComplete(null);
        });
    }

    private static List<String> candidates(String gateway) {
        ArrayList<String> out = new ArrayList<>();
        if (gateway != null && !gateway.isEmpty()) out.add(gateway);
        // DHCP 网关可能是路由器地址，并不一定就是认证门户；此校园网的门户固定为 172.19.0.1。
        if (!out.contains(CAMPUS_PORTAL_HOST)) out.add(CAMPUS_PORTAL_HOST);
        return out;
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
            if (code < 200 || code >= 400) return false;
            try (java.io.InputStream in = conn.getInputStream()) {
                byte[] buffer = new byte[4096];
                int n = in.read(buffer);
                String body = n > 0 ? new String(buffer, 0, n, java.nio.charset.StandardCharsets.UTF_8) : "";
                return body.contains("portalDiscovery(") && body.contains("\"result\"");
            }
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
