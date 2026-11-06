// Owns: the small bubble at the screen's top edge while the AI uses the phone (an accessibility overlay: no extra
// permission, shown above every app) – "Autark is using this phone · Tap to stop": a tap cancels the step now and pauses
// phone use for 30 s – and the one-time question "Use <App>?" with Allow / Not now when the AI reaches an app for the
// first time. The bubble takes no touches outside itself, so the AI's own taps reach the app. Never: stays after the work
// ended (it hides 2 s after the last step), or answers the question itself.
package com.teydralab.autark.android.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

final class UseBubble {
    interface Answer { void answered(boolean allowed); }

    private static final long HIDE_AFTER_MS = 2_000;
    private final AccessibilityService service;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable stopped;
    private LinearLayout view;
    private TextView line;
    private LinearLayout buttons;
    private final Runnable hide = this::remove;

    /** `stopped`: the person tapped the bubble (cancel and pause). */
    UseBubble(AccessibilityService service, Runnable stopped) {
        this.service = service;
        this.windows = (WindowManager) service.getSystemService(AccessibilityService.WINDOW_SERVICE);
        this.stopped = stopped;
    }

    /** Shows "using this phone" while a step runs. */
    void working() {
        main.post(() -> {
            ensure();
            main.removeCallbacks(hide);
            if (view == null) return;
            line.setText("Autark is using this phone · Tap to stop");
            buttons.setVisibility(View.GONE);
        });
    }

    /** The step ended: the bubble goes after a moment, unless the next step comes. */
    void idle() { main.post(() -> { main.removeCallbacks(hide); main.postDelayed(hide, HIDE_AFTER_MS); }); }

    /** "Use <App>?" with Allow / Not now; `answer` hears the tap (or nothing, when the person does not tap). */
    void ask(String app, Answer answer) {
        main.post(() -> {
            ensure();
            main.removeCallbacks(hide);
            if (view == null) { answer.answered(false); return; }
            line.setText("Let the AI use " + app + "?");
            buttons.removeAllViews();
            buttons.addView(button("Allow", () -> { buttons.setVisibility(View.GONE); answer.answered(true); }));
            buttons.addView(button("Not now", () -> { buttons.setVisibility(View.GONE); answer.answered(false); }));
            buttons.setVisibility(View.VISIBLE);
        });
    }

    void close() { main.post(this::remove); }

    private void ensure() {
        if (view != null) return;
        float density = service.getResources().getDisplayMetrics().density;
        view = new LinearLayout(service);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = Math.round(10 * density);
        view.setPadding(pad * 2, pad, pad * 2, pad);
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(235, 32, 36, 34));
        background.setCornerRadius(24 * density);
        view.setBackground(background);
        line = new TextView(service);
        line.setTextColor(Color.WHITE);
        line.setTextSize(14);
        view.addView(line);
        buttons = new LinearLayout(service);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setVisibility(View.GONE);
        view.addView(buttons);
        view.setOnClickListener((tap) -> { if (buttons.getVisibility() != View.VISIBLE) stopped.run(); });
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.round(36 * density);
        try { windows.addView(view, params); } catch (RuntimeException error) { view = null; }
    }

    private Button button(String label, Runnable action) {
        Button button = new Button(service);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener((tap) -> action.run());
        return button;
    }

    private void remove() {
        if (view == null) return;
        try { windows.removeView(view); } catch (RuntimeException ignored) { /* already gone */ }
        view = null;
    }
}
