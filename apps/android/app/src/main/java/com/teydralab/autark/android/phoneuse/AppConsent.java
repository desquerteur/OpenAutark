// Owns: which apps the person let the AI use – asked once per app (the bubble's "Use <App>?"), kept in app-private
// storage. Only this app itself counts as allowed; the system's own screens are asked like any app – the notification
// shade (com.android.systemui) shows other apps' messages, and a window without a package is nobody's to read.
// Never: allows an app the person did not tap Allow for.
package com.teydralab.autark.android.phoneuse;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import java.util.HashSet;
import java.util.Set;

final class AppConsent {
    private static final String KEY = "allowed";
    private final SharedPreferences preferences;
    private final Context context;

    AppConsent(Context context) {
        this.context = context;
        this.preferences = context.getSharedPreferences("phone-use", Context.MODE_PRIVATE);
    }

    boolean allowed(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        if (pkg.equals(context.getPackageName())) return true;
        return preferences.getStringSet(KEY, new HashSet<>()).contains(pkg);
    }

    void allow(String pkg) {
        Set<String> next = new HashSet<>(preferences.getStringSet(KEY, new HashSet<>()));
        next.add(pkg);
        preferences.edit().putStringSet(KEY, next).apply();
    }

    /** "WhatsApp" for com.whatsapp; the package name when the app has no label. */
    String label(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "this system screen";
        if (pkg.equals("com.android.systemui")) return "the notifications and quick settings";
        try {
            PackageManager manager = context.getPackageManager();
            ApplicationInfo info = manager.getApplicationInfo(pkg, 0);
            CharSequence label = manager.getApplicationLabel(info);
            return label == null ? pkg : label.toString();
        } catch (PackageManager.NameNotFoundException error) {
            return pkg;
        }
    }
}
