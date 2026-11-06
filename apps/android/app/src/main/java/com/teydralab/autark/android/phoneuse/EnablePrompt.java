// Owns: the one notification that asks the person to turn phone use on – "Let the AI use this phone": one tap opens
// Android's Accessibility settings (Autark › Use this phone). A sideloaded app on Android 13+ first needs App info › ⋮ ›
// Allow restricted settings – the notification says so and has App info as its second button. At most once in 10 minutes.
// Never: turns anything on itself.
package com.teydralab.autark.android.phoneuse;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

public final class EnablePrompt {
    private static final String CHANNEL = "phone-use";
    private static final int ID = 4107;
    private static final long AGAIN_MS = 10 * 60_000;
    private static volatile long shownAt;

    private EnablePrompt() {}

    /** The text of the prompt (also shown in the app when it is open). */
    public static String text() {
        return Build.VERSION.SDK_INT >= 33
                ? "Tap, then Autark › Use this phone. Greyed out? First App info › ⋮ › Allow restricted settings."
                : "Tap, then Autark › Use this phone.";
    }

    public static void show(Context context) {
        long now = System.currentTimeMillis();
        if (now - shownAt < AGAIN_MS) return;
        shownAt = now;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Phone use", NotificationManager.IMPORTANCE_DEFAULT));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent settings = PendingIntent.getActivity(context, 1, new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        PendingIntent appInfo = PendingIntent.getActivity(context, 2, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", context.getPackageName(), null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Let the AI use this phone").setContentText(text())
                .setStyle(new Notification.BigTextStyle().bigText(text())).setContentIntent(settings).setAutoCancel(true)
                .addAction(new Notification.Action.Builder(null, "App info", appInfo).build());
        try { manager.notify(ID, builder.build()); } catch (SecurityException error) { /* notifications not allowed: the app shows the text when open */ }
    }
}
