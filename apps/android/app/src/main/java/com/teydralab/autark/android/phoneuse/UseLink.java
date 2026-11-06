// Owns: the app's own second socket to the PC (B-078, D6) – /ws through the same local entrance as the WebView (its gate
// cookie, this phone's token), so it lives as long as the phone's connection, also while the app is in the background.
// It calls phoneUse.attach (model, screen, whether phone use is on – again whenever that changes) and keeps the list of
// my PCs the answer brings (the connection then pins all of them), hears phoneUse.request for this device only and
// answers each with phoneUse.reply – one step at a time, on a thread of its own. When phone use is off it answers 'off'
// and shows the enable notification. Reconnects with backoff (2 s … 60 s) after the socket ended or never came up; the
// backoff starts again at 2 s only after a connection brought an attach answer.
// Never: acts on a request for another device, or keeps a step beyond its answer.
package com.teydralab.autark.android.phoneuse;

import android.content.Context;
import android.os.Build;
import android.util.DisplayMetrics;
import com.teydralab.autark.android.relay.Json;
import com.teydralab.autark.android.relay.PhoneConnection;
import com.teydralab.autark.android.relay.StreamProxy;
import com.teydralab.autark.android.relay.WebSocketClient;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class UseLink implements WebSocketClient.Listener {
    /** The PCs of the company arrived (phoneUse.attach). */
    public interface Pcs { void changed(List<PhoneConnection.Pc> pcs); }

    private static final long[] BACKOFF_MS = { 2_000, 5_000, 15_000, 30_000, 60_000 };
    private final Context context;
    private final String origin;
    private final String gate;
    private final String token;
    private final String deviceId;
    private final Pcs pcs;
    private final ExecutorService steps = Executors.newSingleThreadExecutor();
    private final AtomicInteger ids = new AtomicInteger(1);
    private final Object lock = new Object();
    private volatile WebSocketClient socket;
    private volatile int attachId = -1;
    private volatile boolean stopped;
    /** Counts ended sockets (closed() on the reader thread); guarded by lock. */
    private long closes;
    /** The current socket's attach answer arrived. */
    private volatile boolean answered;
    private Thread worker;

    public UseLink(Context context, String origin, String gate, String token, String deviceId, Pcs pcs) {
        this.context = context.getApplicationContext();
        this.origin = origin; this.gate = gate; this.token = token; this.deviceId = deviceId; this.pcs = pcs;
    }

    public void start() {
        UseService.onChange(this::attach);
        worker = new Thread(this::run, "autark-phone-use");
        worker.setDaemon(true);
        worker.start();
    }

    public void stop() {
        stopped = true;
        UseService.onChange(null);
        WebSocketClient ws = socket;
        if (ws != null) ws.close();
        synchronized (lock) { lock.notifyAll(); }
        steps.shutdownNow();
    }

    private void run() {
        int attempt = 0;
        while (!stopped) {
            try {
                long seen;
                synchronized (lock) { seen = closes; answered = false; }
                WebSocketClient ws = WebSocketClient.connect(origin.replaceFirst("^http", "ws") + "/ws", this, "Cookie: " + StreamProxy.GATE_COOKIE + "=" + gate + "\r\n");
                // The reader runs already: a close that came before this line is counted in `closes`, never lost.
                synchronized (lock) { if (closes == seen) socket = ws; }
                if (socket == ws) {
                    send(Json.map("protocol", 1, "token", token, "client", "pwa", "deviceName", model()));
                    send(Json.map("id", ids.getAndIncrement(), "method", "events.subscribe", "params", Json.map("topics", java.util.Collections.singletonList("system"))));
                    attach();
                }
                synchronized (lock) {
                    while (!stopped && closes == seen) lock.wait(60_000);
                    if (socket == ws) socket = null;
                }
                // A PC that accepts the socket and then closes it (unknown token, not on its roster yet) gets the same
                // backoff as one that is out of reach; only an attach answer counts as a working connection.
                if (answered) attempt = 0;
            } catch (IOException error) {
                // out of reach – the backoff below
            } catch (InterruptedException error) {
                return;
            }
            pause(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
        }
    }

    /** phoneUse.attach (again when phone use turned on or off). */
    private void attach() {
        if (socket == null) return;
        int id = ids.getAndIncrement();
        attachId = id;
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        send(Json.map("id", id, "method", "phoneUse.attach", "params", Json.map("model", model(), "ready", UseService.current() != null,
                "screen", Json.map("width", metrics.widthPixels, "height", metrics.heightPixels))));
    }

    @Override public void text(String text) {
        Map<String, Object> frame;
        try { frame = Json.object(text); } catch (IllegalArgumentException error) { return; }
        if ("phoneUse.request".equals(frame.get("event")) && frame.get("data") instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> request = (Map<String, Object>) frame.get("data");
            if (!deviceId.equals(Json.str(request, "deviceId"))) return;
            try { steps.execute(() -> handle(request)); } catch (RuntimeException stopping) { /* shutting down */ }
            return;
        }
        if (Json.num(frame, "id", -1) == attachId && frame.get("result") instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> result = (Map<String, Object>) frame.get("result");
            answered = true;
            List<PhoneConnection.Pc> list = PhoneConnection.Paired.pcsOf(result.get("pcs"));
            if (!list.isEmpty()) pcs.changed(list);
        }
    }

    private void handle(Map<String, Object> request) {
        String id = Json.str(request, "id");
        String op = Json.str(request, "op");
        if (id == null || op == null) return;
        Object args = request.get("args");
        @SuppressWarnings("unchecked") Map<String, Object> params = args instanceof Map ? (Map<String, Object>) args : Json.map();
        UseService service = UseService.current();
        Map<String, Object> reply;
        if (service == null) {
            EnablePrompt.show(context);
            reply = Json.map("id", id, "error", Json.map("code", "off", "message", "Phone use is off on this phone."));
        } else {
            try { reply = Json.map("id", id, "result", service.run(op, params)); }
            catch (UseService.UseError error) { reply = Json.map("id", id, "error", Json.map("code", error.code, "message", String.valueOf(error.getMessage()))); }
            catch (RuntimeException error) { reply = Json.map("id", id, "error", Json.map("code", "conflict", "message", "The step failed on the phone: " + error.getClass().getSimpleName())); }
        }
        send(Json.map("id", ids.getAndIncrement(), "method", "phoneUse.reply", "params", reply));
    }

    private void send(Map<String, Object> frame) {
        WebSocketClient ws = socket;
        if (ws == null) return;
        try { ws.sendText(Json.write(frame)); } catch (IOException error) { ws.close(); }
    }

    @Override public void binary(byte[] data) { /* the RPC socket sends text only */ }

    @Override public void closed(String reason) {
        synchronized (lock) { closes++; socket = null; lock.notifyAll(); }
    }

    private void pause(long ms) {
        synchronized (lock) { if (!stopped) { try { lock.wait(ms); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } } }
    }

    private static String model() {
        String name = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        return name.isEmpty() ? "Android phone" : name.length() > 60 ? name.substring(0, 60) : name;
    }
}
