// Owns: the native shell – pairing by the PC's Remote ID (typed, or the QR's pair link that Android App Links open
// here) with the same code on both screens and Accept on the PC (relay/PhoneConnection, B-078), the one connection to the
// company's PCs (the first one online), the app's own phone-use socket (phoneuse/UseLink) and the WebView that shows the
// PC's unchanged phone UI through it – no toolbar of its own: "Forget this phone" is in the web profile menu (the
// autark-app:forget address). Back goes back layer by layer in the web UI (window.autarkBack) and, with nothing left,
// puts the app in the background – it never closes itself. Its own screens: connect, the code, and "can't reach".
// Never: copies the UI, needs a VPN or a reachable PC address, reads the UI's storage, or runs agents.
package com.teydralab.autark.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import com.teydralab.autark.android.phoneuse.UseLink;
import com.teydralab.autark.android.relay.Crypto;
import com.teydralab.autark.android.relay.Json;
import com.teydralab.autark.android.relay.PhoneConnection;
import com.teydralab.autark.android.relay.StreamProxy;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class MainActivity extends Activity {
    /** The local entrance's preferred port: a stable origin keeps the UI's own storage across starts. */
    private static final int PORT = 47920;
    /** One connection and one phone-use socket per app process (they outlive a recreated activity). */
    private static PhoneConnection connection;
    private static UseLink use;
    private static String connectionOrigin;
    /** The activity on screen: the process-wide connection reports its status there. */
    private static volatile MainActivity current;

    private WebView web;
    private PhoneChrome chrome;
    private FrameLayout content;
    private TextView status;
    private SharedPreferences preferences;
    private String origin;
    private boolean setup;
    private boolean resetHistory;
    private PhoneConnection.Pairing pairing;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        preferences = getSharedPreferences("pairing", MODE_PRIVATE);
        getSharedPreferences("connection", MODE_PRIVATE).edit().clear().apply(); // 0.1.0's https origin is no longer used
        content = new FrameLayout(this);
        content.setBackgroundColor(Color.WHITE);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            }
            return insets;
        });
        setContentView(content);
        createWebView();
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        PhoneConnection.Paired paired = saved();
        String linked = ConnectionAddress.fromLink(getIntent() == null ? null : getIntent().getDataString());
        if (paired == null) showConnect(linked);
        else open(paired);
        UpdateCheck.start(this);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String linked = ConnectionAddress.fromLink(intent.getDataString());
        if (linked != null && saved() == null) showConnect(linked);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Android document picker supplies content:// URIs.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " AutarkAndroid/0.3.3");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(false);
        chrome = new PhoneChrome(this, web, () -> origin);
        web.setWebChromeClient(chrome);
        web.setWebViewClient(new PhoneNavigation(this));
        web.setDownloadListener((url, agent, disposition, mime, length) ->
                Toast.makeText(this, "Downloads open on the PC; the phone shows files in the app.", Toast.LENGTH_LONG).show());
    }

    // ------------------------------------------------------------------ pairing and connection

    private PhoneConnection.Paired saved() {
        String seed = preferences.getString("seed", "");
        if (seed.isEmpty()) return null;
        List<PhoneConnection.Pc> pcs;
        try { pcs = PhoneConnection.Paired.pcsOf(Json.parse(preferences.getString("pcs", "[]"))); } catch (IllegalArgumentException error) { pcs = new ArrayList<>(); }
        String oldFp = preferences.getString("pcFingerprint", ""); // 0.3.x: one PC
        if (pcs.isEmpty() && !oldFp.isEmpty()) pcs.add(new PhoneConnection.Pc(oldFp, preferences.getString("pcPublicKey", ""), preferences.getString("pcName", "PC"), ""));
        if (pcs.isEmpty()) return null;
        return new PhoneConnection.Paired(preferences.getString("relay", ConnectionAddress.DEFAULT_RELAY), seed, preferences.getString("deviceId", ""),
                preferences.getString("token", ""), pcs);
    }

    private void store(PhoneConnection.Paired paired) {
        preferences.edit().putString("relay", paired.relay).putString("seed", paired.seed).putString("deviceId", paired.deviceId)
                .putString("token", paired.token).putString("pcs", paired.pcsJson()).remove("pcFingerprint").remove("pcPublicKey").remove("pcName")
                .putString("gate", preferences.getString("gate", "").isEmpty() ? Crypto.b64url(Crypto.random(24)) : preferences.getString("gate", "")).apply();
    }

    /** Starts (or reuses) the connection and the phone-use socket, lets only this WebView through the local entrance, opens the PC's UI. */
    private void open(PhoneConnection.Paired paired) {
        if (preferences.getString("gate", "").isEmpty()) store(paired);
        String gate = preferences.getString("gate", "");
        if (connection == null) {
            PhoneConnection next = new PhoneConnection(paired, (text, connected) -> {
                MainActivity shown = current;
                if (shown != null) shown.runOnUiThread(() -> shown.status(text, connected));
            });
            try { connectionOrigin = next.start(PORT, gate); }
            catch (IOException error) { showConnect(null); status("The app could not open its local entrance: " + error.getMessage(), false); return; }
            connection = next;
            use = new UseLink(this, connectionOrigin, gate, paired.token, paired.deviceId, (pcs) -> {
                PhoneConnection live = connection;
                if (live == null) return;
                live.updatePcs(pcs);
                MainActivity shown = current;
                if (shown != null) shown.runOnUiThread(() -> shown.store(live.paired()));
            });
            use.start();
        }
        origin = connectionOrigin;
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(origin, StreamProxy.GATE_COOKIE + "=" + gate + "; Path=/; HttpOnly; SameSite=Strict");
        cookies.flush();
        chrome.cancelMedia();
        setup = false;
        content.removeAllViews();
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.onResume();
        resetHistory = true;
        // The phone UI keeps the token itself (lib/rpc.ts reads #token=, stores it and removes it from the address).
        web.loadUrl(origin + "/#token=" + Uri.encode(paired.token));
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
                && !preferences.getBoolean("askedNotifications", false)) {
            preferences.edit().putBoolean("askedNotifications", true).apply();
            requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 43); // the phone-use prompt
        }
    }

    /** The connect screen: one field, the Remote ID (filled from a scanned pair link, which starts at once). */
    private void showConnect(String remoteId) {
        leaveWeb();
        LinearLayout form = screen();
        TextView help = text("Connect to your Autark PC", 20, Color.BLACK);
        form.addView(help);
        form.addView(text("On the PC: Settings › Devices › Connect a phone. Scan its QR code with the camera, or type the Remote ID. Both screens then show the same code – accept on the PC.", 15, Color.DKGRAY));
        EditText field = new EditText(this);
        field.setHint("Remote ID (9 digits)");
        field.setInputType(InputType.TYPE_CLASS_NUMBER);
        field.setSingleLine(true);
        field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        field.setSaveEnabled(false);
        if (remoteId != null) field.setText(remoteId);
        form.addView(field, new LinearLayout.LayoutParams(-1, dp(64)));
        Runnable connect = () -> {
            String id;
            try { id = ConnectionAddress.remoteId(field.getText().toString()); } catch (IllegalArgumentException error) { field.setError(error.getMessage()); return; }
            ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(field.getWindowToken(), 0);
            pair(id);
        };
        form.addView(button("Connect", connect));
        status = text("", 13, Color.DKGRAY);
        form.addView(status);
        if (remoteId != null) connect.run();
    }

    /** Pairing: the code to compare while the person accepts on the PC; Cancel ends it there too. */
    private void pair(String remoteId) {
        if (pairing != null) return;
        PhoneConnection.Pairing running = new PhoneConnection.Pairing();
        pairing = running;
        LinearLayout form = screen();
        form.addView(text("Connecting…", 20, Color.BLACK));
        TextView line = text("Finding the PC through Autark's meeting server…", 15, Color.DKGRAY);
        form.addView(line);
        TextView code = text("", 40, Color.BLACK);
        code.setGravity(Gravity.CENTER_HORIZONTAL);
        form.addView(code);
        form.addView(button("Cancel", () -> { running.cancel(); pairing = null; showConnect(null); }));
        String name = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        new Thread(() -> {
            try {
                PhoneConnection.Paired paired = PhoneConnection.pair(ConnectionAddress.DEFAULT_RELAY, remoteId, name, running, (digits, pcName) -> runOnUiThread(() -> {
                    code.setText(digits.replaceAll("(\\d)(?=\\d)", "$1 "));
                    line.setText("Accept on " + pcName + " if it shows the same code.");
                }));
                runOnUiThread(() -> { pairing = null; store(paired); open(paired); });
            } catch (IOException error) {
                runOnUiThread(() -> {
                    if (pairing != running) return;
                    pairing = null;
                    showConnect(remoteId);
                    status(error.getMessage() == null ? "Pairing failed." : error.getMessage(), false);
                });
            }
        }, "autark-pair").start();
    }

    /** The web UI could not load: the reason, Try again, and Forget (the web profile menu is out of reach). */
    void offline(String reason) {
        if (setup) return;
        leaveWeb();
        LinearLayout form = screen();
        form.addView(text("Can't reach your PC right now", 20, Color.BLACK));
        status = text(reason, 15, Color.DKGRAY);
        form.addView(status);
        form.addView(button("Try again", () -> { PhoneConnection.Paired paired = saved(); if (connection != null) connection.nudge(); if (paired != null) open(paired); }));
        form.addView(button("Forget this phone", this::confirmForget));
    }

    /** "Forget this phone" (the web profile menu sends autark-app:forget). */
    void confirmForget() {
        new AlertDialog.Builder(this)
                .setMessage("Sign this phone out and remove its pairing here? On the PC, remove it under Settings › Devices too.")
                .setNegativeButton("Cancel", null).setPositiveButton("Forget", (dialog, which) -> forget()).show();
    }

    private void forget() {
        if (use != null) { use.stop(); use = null; }
        if (connection != null) { connection.stop(); connection = null; connectionOrigin = null; }
        chrome.dispose();
        web.stopLoading();
        web.clearCache(true);
        web.clearHistory();
        web.destroy();
        CookieManager.getInstance().removeAllCookies(null);
        android.webkit.WebStorage.getInstance().deleteAllData();
        preferences.edit().clear().apply(); origin = null;
        createWebView();
        showConnect(null);
    }

    private void leaveWeb() {
        setup = true;
        chrome.cancelMedia();
        web.stopLoading();
        web.loadUrl("about:blank"); // Leaving the app page releases its live camera/microphone streams.
        web.onPause();
    }

    private LinearLayout screen() {
        content.removeAllViews();
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(24), dp(32), dp(24), dp(24));
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(form);
        content.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        return form;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setPadding(0, 0, 0, dp(12));
        return view;
    }

    boolean sameOrigin(String url) { return origin != null && ConnectionAddress.sameOrigin(origin, url); }

    void openExternal(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto") || scheme.equals("tel"))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "No app is installed to open this link.", Toast.LENGTH_SHORT).show(); }
    }

    /** The connection's line on the app's own screens (the web UI shows its own state). */
    void status(String value, boolean connected) {
        if (status != null) status.setText(value);
    }

    void pageReady() { if (resetHistory) { web.clearHistory(); resetHistory = false; } }

    private Button button(String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false);
        button.setOnClickListener(view -> action.run()); return button;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    /** Back: the connect screen returns to the app; the web UI goes back one layer; with none left the app goes to the background. */
    private void goBack() {
        PhoneConnection.Paired paired = saved();
        if (setup && paired != null && pairing == null) { open(paired); return; }
        if (setup) { moveTaskToBack(true); return; }
        web.evaluateJavascript("(function(){try{return window.autarkBack?window.autarkBack():false}catch(e){return false}})()",
                (value) -> { if (!"true".equals(value)) moveTaskToBack(true); });
    }

    // API 33+ uses the OnBackInvokedDispatcher above; this callback covers Android 8–12.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { goBack(); }
    @Override protected void onResume() { super.onResume(); if (connection != null) connection.nudge(); if (web != null && !setup) web.onResume(); }
    @Override protected void onPause() { if (web != null) web.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onDestroy() { if (current == this) current = null; if (chrome != null) chrome.dispose(); if (web != null) { content.removeAllViews(); web.destroy(); } super.onDestroy(); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) { super.onRequestPermissionsResult(code, permissions, results); chrome.permissionResult(code); }
    @Override protected void onActivityResult(int code, int result, Intent data) { super.onActivityResult(code, result, data); chrome.activityResult(code, result, data); }
}
