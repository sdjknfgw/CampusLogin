// 开机自启：配置了自启且已填写账号时，开机后拉起前台服务引擎
package com.campuslogin.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        Prefs.Config s = Prefs.load(context);
        if (s.bootStart && !s.account.isEmpty() && !s.password.isEmpty()) {
            LoginService.start(context);
        }
    }
}
