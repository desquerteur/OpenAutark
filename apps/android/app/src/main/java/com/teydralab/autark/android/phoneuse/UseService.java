// Owns: phone use (B-078, D6) – an AccessibilityService that reads nothing until a request asks (its config listens to
// window changes only, and this class ignores them), then does one step: ui_tree (the active window's tree,
// ScreenTree), screenshot (Android 11+; every app window on the display must be allowed), tap (ACTION_CLICK on the element there, else a short press), swipe (a curved,
// jittered finger path, Gestures), type (ACTION_SET_TEXT on the focused field, Enter between lines), key (back, home,
// recents, notifications, quick_settings, enter) and open (an app or a link). Each step shows the bubble (UseBubble); a
// tap on it cancels and pauses for 30 s; an app the AI reaches for the first time asks the person once (AppConsent).
// The PC asks through UseLink. Never: acts while paused, in an app the person did not allow, or reads a password's text.
package com.teydralab.autark.android.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import com.teydralab.autark.android.relay.Json;

public final class UseService extends AccessibilityService {
    /** A refused or failed step: `code` as phoneUse.reply's error code. */
    public static final class UseError extends Exception {
        public final String code;
        UseError(String code, String message) { super(message); this.code = code; }
    }

    private static final long PAUSE_MS = 30_000;
    private static final long CONSENT_WAIT_MS = 15_000;
    private static final int SHOT_WIDTH = 720;
    private static volatile UseService current;
    private static volatile Runnable changed;

    private final Random random = new Random();
    private UseBubble bubble;
    private AppConsent consent;
    private volatile long pausedUntil;
    private volatile boolean cancelled;

    /** The service while it is on (Accessibility settings), else null. */
    public static UseService current() { return current; }

    /** Called when the service turns on or off (UseLink tells the PC). */
    public static void onChange(Runnable listener) { changed = listener; }

    @Override protected void onServiceConnected() {
        consent = new AppConsent(this);
        bubble = new UseBubble(this, () -> { cancelled = true; pausedUntil = System.currentTimeMillis() + PAUSE_MS; bubble.idle(); });
        current = this;
        Runnable listener = changed;
        if (listener != null) listener.run();
    }

    @Override public boolean onUnbind(Intent intent) {
        current = null;
        if (bubble != null) bubble.close();
        Runnable listener = changed;
        if (listener != null) listener.run();
        return super.onUnbind(intent);
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* nothing is read until a request asks */ }

    @Override public void onInterrupt() { cancelled = true; }

    /** One step (off the main thread); the result as phoneUse.reply's `result`. */
    public Object run(String op, Map<String, Object> args) throws UseError {
        if (System.currentTimeMillis() < pausedUntil) throw new UseError("paused", "The person tapped the bubble: phone use is paused for 30 s.");
        cancelled = false;
        bubble.working();
        try {
            switch (op) {
                case "ui_tree": return tree();
                case "screenshot": return screenshot();
                case "tap": tap(num(args, "x"), num(args, "y")); return Json.map();
                case "swipe": swipe(num(args, "x1"), num(args, "y1"), num(args, "x2"), num(args, "y2"), (long) num(args, "durationMs")); return Json.map();
                case "type": type(Json.str(args, "text")); return Json.map();
                case "key": return Json.map("key", key(Json.str(args, "key")));
                case "open": return Json.map("opened", open(Json.str(args, "url"), Json.str(args, "package")));
                default: throw new UseError("bad_request", "Unknown step " + op + ".");
            }
        } finally {
            bubble.idle();
        }
    }

    // ------------------------------------------------------------------ steps

    private Map<String, Object> tree() throws UseError {
        AccessibilityNodeInfo root = rootAllowed();
        int[] screen = screen();
        return Json.map("nodes", ScreenTree.flatten(new Wrapped(root)), "screen", Json.map("width", screen[0], "height", screen[1]));
    }

    private Map<String, Object> screenshot() throws UseError {
        if (Build.VERSION.SDK_INT < 30) throw new UseError("unavailable", "Screenshots need Android 11 or newer; phone.ui_tree reads the screen.");
        rootAllowed();
        visibleAllowed(); // the shot shows the whole display: split screen, a heads-up notice, picture in picture
        AtomicReference<Bitmap> shot = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult result) {
                Bitmap hardware = Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
                if (hardware != null) shot.set(hardware.copy(Bitmap.Config.ARGB_8888, false));
                result.getHardwareBuffer().close();
                done.countDown();
            }
            @Override public void onFailure(int code) { done.countDown(); }
        });
        await(done, 5_000);
        Bitmap full = shot.get();
        if (full == null) throw new UseError("unavailable", "Android did not hand over a screenshot right now (at most one per second).");
        int width = Math.min(SHOT_WIDTH, full.getWidth());
        int height = Math.round(full.getHeight() * (width / (float) full.getWidth()));
        Bitmap scaled = width == full.getWidth() ? full : Bitmap.createScaledBitmap(full, width, height, true);
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, 70, jpeg);
        return Json.map("data", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP), "mime", "image/jpeg", "width", width, "height", height,
                "screen", Json.map("width", full.getWidth(), "height", full.getHeight()));
    }

    private void tap(float x, float y) throws UseError {
        AccessibilityNodeInfo root = rootAllowed();
        List<ScreenTree.Node> visited = new ArrayList<>();
        List<Map<String, Object>> rows = ScreenTree.flatten(new Wrapped(root), visited);
        int index = ScreenTree.clickableAt(rows, Math.round(x), Math.round(y));
        if (index >= 0 && ((Wrapped) visited.get(index)).info.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
        int[] screen = screen();
        Gestures.Stroke press = Gestures.tap(x, y, screen[0], screen[1], random);
        gesture(press);
    }

    private void swipe(float x1, float y1, float x2, float y2, long durationMs) throws UseError {
        rootAllowed();
        int[] screen = screen();
        gesture(Gestures.swipe(x1, y1, x2, y2, durationMs <= 0 ? 400 : durationMs, screen[0], screen[1], random));
    }

    private void type(String text) throws UseError {
        if (text == null) throw new UseError("bad_request", "No text.");
        AccessibilityNodeInfo root = rootAllowed();
        AccessibilityNodeInfo field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null || !field.isEditable()) throw new UseError("conflict", "No text field has the focus: I tap the field first.");
        String[] lines = text.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            if (cancelled) throw new UseError("cancelled", "The person stopped phone use.");
            if (!lines[i].isEmpty()) {
                CharSequence before = field.isShowingHintText() ? "" : field.getText();
                Bundle value = new Bundle();
                value.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, (before == null ? "" : before) + lines[i]);
                if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, value)) throw new UseError("conflict", "The field did not take the text.");
                field.refresh();
            }
            if (i < lines.length - 1) enter(field);
        }
    }

    private String key(String name) throws UseError {
        String key = name == null ? "" : name.trim().toLowerCase(java.util.Locale.ROOT);
        int action;
        switch (key) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": case "app_switch": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": action = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "enter": {
                AccessibilityNodeInfo root = rootAllowed();
                AccessibilityNodeInfo field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (field == null) throw new UseError("conflict", "No text field has the focus for Enter.");
                enter(field);
                return "enter";
            }
            default: throw new UseError("bad_request", "Through the Autark app the keys are back, home, recents, notifications, quick_settings and enter.");
        }
        if (!performGlobalAction(action)) throw new UseError("conflict", "Android did not press " + key + ".");
        return key;
    }

    private String open(String url, String pkg) throws UseError {
        Intent intent;
        if (pkg != null && !pkg.isEmpty()) {
            if (!consent.allowed(pkg) && !askConsent(pkg)) throw new UseError("consent", "The person did not let the AI use " + consent.label(pkg) + " (yet).");
            intent = getPackageManager().getLaunchIntentForPackage(pkg);
            if (intent == null) throw new UseError("not_found", pkg + " is not installed on this phone.");
        } else if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        } else {
            throw new UseError("bad_request", "Give an http(s) link or a package name.");
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { startActivity(intent); } catch (RuntimeException error) { throw new UseError("conflict", "Android did not open it: " + error.getMessage()); }
        return pkg != null && !pkg.isEmpty() ? pkg : url;
    }

    // ------------------------------------------------------------------ helpers

    /** The active window, once its app is allowed (asked once per app). */
    private AccessibilityNodeInfo rootAllowed() throws UseError {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new UseError("unavailable", "The screen has no readable window right now (locked, or a game drawing itself): phone.screenshot shows it.");
        CharSequence pkg = root.getPackageName();
        String name = pkg == null ? "" : pkg.toString();
        if (!consent.allowed(name) && !askConsent(name)) throw new UseError("consent", "The person did not let the AI use " + consent.label(name) + " (yet).");
        return root;
    }

    /** Every app window on the display (not the keyboard, not my bubble) is one the person allowed, else nothing is shot. */
    private void visibleAllowed() throws UseError {
        for (AccessibilityWindowInfo window : getWindows()) {
            int type = window.getType();
            if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD || type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            CharSequence pkg = root.getPackageName();
            String name = pkg == null ? "" : pkg.toString();
            if (!consent.allowed(name) && !askConsent(name)) throw new UseError("consent", "The person did not let the AI see " + consent.label(name) + " (yet), and it is on the screen.");
        }
    }

    private boolean askConsent(String pkg) throws UseError {
        CountDownLatch answered = new CountDownLatch(1);
        AtomicBoolean allowed = new AtomicBoolean(false);
        bubble.ask(consent.label(pkg), (yes) -> { allowed.set(yes); answered.countDown(); });
        await(answered, CONSENT_WAIT_MS);
        if (allowed.get()) consent.allow(pkg);
        bubble.working();
        return allowed.get();
    }

    private void enter(AccessibilityNodeInfo field) throws UseError {
        if (Build.VERSION.SDK_INT < 30 || !field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
            throw new UseError("conflict", "This field did not take Enter.");
        }
    }

    private void gesture(Gestures.Stroke stroke) throws UseError {
        if (cancelled) throw new UseError("cancelled", "The person stopped phone use.");
        Path path = new Path();
        path.moveTo(stroke.points[0], stroke.points[1]);
        for (int i = 2; i < stroke.points.length; i += 2) path.lineTo(stroke.points[i], stroke.points[i + 1]);
        GestureDescription description = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, stroke.durationMs)).build();
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        boolean sent = dispatchGesture(description, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription gesture) { ok.set(true); done.countDown(); }
            @Override public void onCancelled(GestureDescription gesture) { done.countDown(); }
        }, null);
        if (!sent) throw new UseError("conflict", "Android did not take the gesture.");
        await(done, stroke.durationMs + 3_000);
        if (!ok.get()) throw new UseError(cancelled ? "cancelled" : "conflict", cancelled ? "The person stopped phone use." : "The gesture was interrupted.");
    }

    private int[] screen() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = ((android.view.WindowManager) getSystemService(WINDOW_SERVICE)).getCurrentWindowMetrics().getBounds();
            return new int[] { bounds.width(), bounds.height() };
        }
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        return new int[] { metrics.widthPixels, metrics.heightPixels };
    }

    private static void await(CountDownLatch latch, long ms) throws UseError {
        try { latch.await(ms, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new UseError("cancelled", "Interrupted."); }
    }

    private static float num(Map<String, Object> args, String key) throws UseError {
        Object value = args.get(key);
        if (!(value instanceof Number)) throw new UseError("bad_request", key + " is missing.");
        return ((Number) value).floatValue();
    }

    /** An AccessibilityNodeInfo as ScreenTree reads it. */
    private static final class Wrapped implements ScreenTree.Node {
        final AccessibilityNodeInfo info;
        Wrapped(AccessibilityNodeInfo info) { this.info = info; }
        @Override public CharSequence text() { return info.getText(); }
        @Override public CharSequence desc() { return info.getContentDescription(); }
        @Override public String id() { return info.getViewIdResourceName(); }
        @Override public CharSequence cls() { return info.getClassName(); }
        @Override public CharSequence pkg() { return info.getPackageName(); }
        @Override public int[] bounds() { Rect r = new Rect(); info.getBoundsInScreen(r); return new int[] { r.left, r.top, r.right, r.bottom }; }
        @Override public boolean visible() { return info.isVisibleToUser(); }
        @Override public boolean clickable() { return info.isClickable(); }
        @Override public boolean scrollable() { return info.isScrollable(); }
        @Override public boolean checkable() { return info.isCheckable(); }
        @Override public boolean checked() { return info.isChecked(); }
        @Override public boolean enabled() { return info.isEnabled(); }
        @Override public boolean focused() { return info.isFocused(); }
        @Override public boolean selected() { return info.isSelected(); }
        @Override public boolean password() { return info.isPassword(); }
        @Override public int childCount() { return info.getChildCount(); }
        @Override public ScreenTree.Node child(int index) { AccessibilityNodeInfo child = info.getChild(index); return child == null ? null : new Wrapped(child); }
    }
}
