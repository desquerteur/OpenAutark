// Owns: the app's own update check (B-078, D18) – at most once a day, in the release build only, it reads
// latest-android.json of the newest public release (github.com/desquerteur/OpenAutark: {versionCode, versionName, url,
// sha256, bytes, signer}) and, when its versionCode is newer than the installed one, offers "Update", which opens the
// APK's address in the browser (Android installs it over this app – same signature). Later remembers that version.
// Never: downloads or installs by itself, or nags twice for the same version.
package com.teydralab.autark.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import com.teydralab.autark.android.relay.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

final class UpdateCheck {
    static final String FEED = "https://github.com/desquerteur/OpenAutark/releases/latest/download/latest-android.json";
    private static final long DAY_MS = 24 * 60 * 60_000L;
    private static final int MAX_BYTES = 16 * 1024;

    private UpdateCheck() {}

    /** The newer release in `json` than `installed`, else null (pure: host-testable). */
    static Map<String, Object> newer(String json, long installed) {
        Map<String, Object> release;
        try { release = Json.object(json); } catch (IllegalArgumentException error) { return null; }
        long code = Json.num(release, "versionCode", -1);
        String url = Json.str(release, "url");
        if (code <= installed || url == null || !url.startsWith("https://github.com/desquerteur/OpenAutark/")) return null;
        return release;
    }

    /** Starts the check in the background; a newer version shows one dialog on `activity`. */
    static void start(Activity activity) {
        if ((activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) return; // the preview build updates by hand
        SharedPreferences preferences = activity.getSharedPreferences("update", Activity.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (now - preferences.getLong("checkedAt", 0) < DAY_MS) return;
        preferences.edit().putLong("checkedAt", now).apply();
        long installed = installedCode(activity);
        new Thread(() -> {
            Map<String, Object> release;
            try { release = newer(fetch(), installed); } catch (IOException error) { return; }
            if (release == null || Json.num(release, "versionCode", -1) == preferences.getLong("later", -1)) return;
            activity.runOnUiThread(() -> {
                if (activity.isFinishing()) return;
                String name = Json.str(release, "versionName");
                new AlertDialog.Builder(activity)
                        .setMessage("Autark " + (name == null ? "" : name + " ") + "is ready for this phone.")
                        .setNegativeButton("Later", (dialog, which) -> preferences.edit().putLong("later", Json.num(release, "versionCode", -1)).apply())
                        .setPositiveButton("Update", (dialog, which) -> {
                            try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(Json.str(release, "url")))); }
                            catch (RuntimeException error) { /* no browser */ }
                        }).show();
            });
        }, "autark-update").start();
    }

    private static long installedCode(Activity activity) {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : legacyCode(info);
        } catch (PackageManager.NameNotFoundException error) {
            return Long.MAX_VALUE;
        }
    }

    @SuppressWarnings("deprecation")
    private static long legacyCode(PackageInfo info) { return info.versionCode; }

    private static String fetch() throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(FEED).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setInstanceFollowRedirects(true);
        try (InputStream in = connection.getInputStream()) {
            if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_BYTES) throw new IOException("too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }
}
