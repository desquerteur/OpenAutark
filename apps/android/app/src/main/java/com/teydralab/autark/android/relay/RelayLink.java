// Owns: this phone's one connection to Autark's meeting server (services/remote-relay, protocol v1) – registration
// with the phone's own device key, the PCs it pins (B-078: every PC of the company it belongs to, in the order the app
// keeps them), presence of those PCs, finding a PC by Remote ID, sealed pairing requests and tunnels it opens –
// mirroring the PC side (rendezvous/relay-client.ts). A connection silent for 90 s ends.
// Never: trusts a box key its PC's device key did not sign, accepts tunnels, or makes this phone findable.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

public final class RelayLink implements WebSocketClient.Listener {
    public interface Events {
        /** A PC this phone pins came online (true) or left (false) at the server. */
        void presence(boolean online);
        /** The server connection ended. */
        void down(String reason);
    }

    public static final String PAIR_INFO = "wf-relay-pair-v1";
    public static final String TUNNEL_INFO = "wf-relay-tunnel-v1";
    private static final long WATCHDOG_MS = 90_000;

    public static final class Found {
        public final String fingerprint;
        public final byte[] publicKey;
        public final String box;
        Found(String fingerprint, byte[] publicKey, String box) { this.fingerprint = fingerprint; this.publicKey = publicKey; this.box = box; }
    }

    private final byte[] seed;
    private final byte[] publicKey;
    /** fingerprint → raw Ed25519 key of each pinned PC, in the app's order. */
    private final Map<String, byte[]> pins;
    private final Events events;
    private final byte[][] box = Crypto.x25519Pair();
    private final String boxPub = Crypto.b64url(box[1]);
    private final Map<Integer, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();
    private final Map<Integer, Tunnel> tunnels = new ConcurrentHashMap<>();
    private final AtomicInteger nextRef = new AtomicInteger(1);
    private final CompletableFuture<Boolean> ready = new CompletableFuture<>();
    private volatile WebSocketClient socket;
    /** Box keys of the pinned PCs online now. */
    private final Map<String, String> boxes = new ConcurrentHashMap<>();
    private volatile long lastTraffic = System.currentTimeMillis();
    private volatile boolean down;

    /** `pins`: fingerprint → key of the PCs this phone belongs to (empty while pairing: nothing pinned). */
    public RelayLink(byte[] seed, Map<String, byte[]> pins, Events events) {
        this.seed = seed;
        this.publicKey = Crypto.ed25519Public(seed);
        this.pins = new java.util.LinkedHashMap<>(pins);
        this.events = events;
    }

    /** Connects and registers; returns once the server said ready. */
    public void connect(String url) throws IOException {
        socket = WebSocketClient.connect(url, this);
        try { ready.get(15, TimeUnit.SECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); close(); throw new IOException("Interrupted"); }
        catch (ExecutionException | TimeoutException error) { close(); throw new IOException("The meeting server did not register this phone."); }
    }

    public boolean isUp() { return !down && ready.isDone(); }

    /** True when the server reported a pinned PC online (with a box key its device key signed). */
    public boolean pcOnline() { return !boxes.isEmpty(); }

    /** The first pinned PC online, in the app's order (null when none is). */
    public String firstOnline() {
        for (String fp : pins.keySet()) if (boxes.containsKey(fp)) return fp;
        return null;
    }

    /** Ends the connection when nothing arrived for 90 s (the server pings every 30 s). */
    public void checkAlive() {
        if (!down && System.currentTimeMillis() - lastTraffic > WATCHDOG_MS) {
            WebSocketClient ws = socket;
            if (ws != null) ws.close();
        }
    }

    public void close() {
        WebSocketClient ws = socket;
        if (ws != null) ws.close();
        else closed("closed");
    }

    // ------------------------------------------------------------------ requests

    /** The PCs that accept requests under this Remote ID (key checked against the ID, box signed by that key). */
    public List<Found> find(String remoteId) throws IOException {
        Map<String, Object> reply = ask(Json.map("t", "find", "id", remoteId), 10_000);
        List<Found> out = new ArrayList<>();
        Object entries = reply.get("entries");
        if (!(entries instanceof List)) return out;
        for (Object item : (List<?>) entries) {
            if (!(item instanceof Map) || out.size() >= 4) continue;
            @SuppressWarnings("unchecked") Map<String, Object> entry = (Map<String, Object>) item;
            String pub = Json.str(entry, "pub");
            if (pub == null) continue;
            byte[] key;
            try { key = Crypto.fromB64url(pub); } catch (IllegalArgumentException error) { continue; }
            if (key.length != 32 || !boxSigned(key, Json.str(entry, "box"), Json.str(entry, "boxSig"))) continue;
            String fp = Crypto.fingerprint(key);
            if (Crypto.remoteId(fp).equals(remoteId)) out.add(new Found(fp, key, Json.str(entry, "box")));
        }
        return out;
    }

    /** One sealed message to a PC found by Remote ID and its opened reply. */
    public Map<String, Object> request(Found pc, Object body, long timeoutMs) throws IOException {
        byte[][] eph = Crypto.x25519Pair();
        byte[] boxRaw = Crypto.fromB64url(pc.box);
        byte[] okm = Crypto.hkdf(Crypto.x25519(eph[0], boxRaw), Crypto.concat(eph[1], boxRaw), PAIR_INFO, 64);
        byte[] toOwner = java.util.Arrays.copyOfRange(okm, 0, 32);
        byte[] toOpener = java.util.Arrays.copyOfRange(okm, 32, 64);
        String sealed = Crypto.b64url(Crypto.seal(toOwner, 0, Crypto.utf8(Json.write(body))));
        Map<String, Object> reply = ask(Json.map("t", "pair", "to", pc.fingerprint, "e", Crypto.b64url(eph[1]), "c", sealed), timeoutMs);
        if (reply.get("error") instanceof String) throw new IOException("The meeting server could not deliver the request (" + reply.get("error") + ").");
        String c = Json.str(reply, "c");
        byte[] raw = c == null ? null : Crypto.fromB64url(c);
        byte[] plain = raw == null ? null : Crypto.open(toOpener, 0, raw, 0, raw.length);
        if (plain == null) throw new IOException("The reply could not be opened.");
        return Json.object(new String(plain, java.nio.charset.StandardCharsets.UTF_8));
    }

    /** A tunnel to the pinned PC `fp`; the opener's ephemeral key is signed with this phone's device key. */
    public Tunnel open(String fp) throws IOException {
        String box = fp == null ? null : boxes.get(fp);
        if (box == null) throw new IOException("Your PC is not online at the meeting server.");
        byte[][] eph = Crypto.x25519Pair();
        byte[] boxRaw = Crypto.fromB64url(box);
        byte[] okm = Crypto.hkdf(Crypto.x25519(eph[0], boxRaw), Crypto.concat(eph[1], boxRaw), TUNNEL_INFO, 64);
        String e = Crypto.b64url(eph[1]);
        String es = Crypto.b64url(Crypto.sign(seed, Crypto.utf8("wf-relay-v1|tunnel|" + e + "|" + box)));
        Map<String, Object> reply = ask(Json.map("t", "open", "to", fp, "e", e, "es", es), 10_000);
        long tid = Json.num(reply, "tid", -1);
        if (tid < 0 || !"opened".equals(reply.get("t"))) throw new IOException("The meeting server did not open a tunnel.");
        Tunnel tunnel = new Tunnel((int) tid, fp, new Tunnel.Link() {
            @Override public void send(byte[] frame) {
                WebSocketClient ws = socket;
                try { if (ws != null) ws.sendBinary(frame); } catch (IOException error) { ws.close(); }
            }
            @Override public void close(int id) {
                tunnels.remove(id);
                sendJson(Json.map("t", "close", "tid", id));
            }
        }, java.util.Arrays.copyOfRange(okm, 0, 32), java.util.Arrays.copyOfRange(okm, 32, 64));
        tunnels.put(tunnel.tid, tunnel);
        return tunnel;
    }

    private Map<String, Object> ask(Map<String, Object> frame, long timeoutMs) throws IOException {
        if (!isUp()) throw new IOException("The meeting server is not connected.");
        int ref = nextRef.getAndIncrement();
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        pending.put(ref, future);
        frame.put("ref", ref);
        sendJson(frame);
        try {
            Map<String, Object> reply = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            if ("error".equals(reply.get("t"))) throw new IOException("The meeting server refused this (" + reply.get("code") + ").");
            return reply;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted");
        } catch (ExecutionException error) {
            throw new IOException("The meeting server connection ended.");
        } catch (TimeoutException error) {
            throw new IOException("The meeting server did not answer in time.");
        } finally {
            pending.remove(ref);
        }
    }

    private void sendJson(Map<String, Object> frame) {
        WebSocketClient ws = socket;
        if (ws == null) return;
        try { ws.sendText(Json.write(frame)); } catch (IOException error) { ws.close(); }
    }

    // ------------------------------------------------------------------ frames from the server

    @Override public void text(String text) {
        lastTraffic = System.currentTimeMillis();
        Map<String, Object> frame;
        try { frame = Json.object(text); } catch (IllegalArgumentException error) { return; }
        String type = Json.str(frame, "t");
        if (type == null) return;
        switch (type) {
            case "challenge": {
                String n = Json.str(frame, "n");
                if (n == null || n.length() > 64) { close(); return; }
                List<Object> peers = new ArrayList<>(pins.keySet());
                sendJson(Json.map("t", "hello", "v", 1, "pub", Crypto.b64url(publicKey),
                        "sig", Crypto.b64url(Crypto.sign(seed, Crypto.utf8("wf-relay-v1|hello|" + n))),
                        "box", boxPub, "boxSig", Crypto.b64url(Crypto.sign(seed, Crypto.utf8("wf-relay-v1|box|" + boxPub))),
                        "peers", peers, "findable", false));
                return;
            }
            case "ready": {
                Object online = frame.get("online");
                if (online instanceof List) for (Object entry : (List<?>) online) if (entry instanceof Map) seen(cast(entry));
                ready.complete(true);
                return;
            }
            case "presence":
                if (Boolean.TRUE.equals(frame.get("online"))) seen(frame);
                else if (frame.get("fp") instanceof String && boxes.remove((String) frame.get("fp")) != null) events.presence(false);
                return;
            case "closed": {
                Tunnel tunnel = tunnels.remove((int) Json.num(frame, "tid", -1));
                if (tunnel != null) tunnel.ended();
                return;
            }
            case "incoming": // this phone accepts no tunnels: only a pinned PC could open one, and it never does
                sendJson(Json.map("t", "close", "tid", Json.num(frame, "tid", -1)));
                return;
            case "pair": // nobody pairs with a phone through the server
                sendJson(Json.map("t", "pairReply", "ref", frame.get("ref"), "error", "failed"));
                return;
            default: {
                long ref = Json.num(frame, "ref", -1);
                CompletableFuture<Map<String, Object>> future = ref < 0 ? null : pending.get((int) ref);
                if (future != null) future.complete(frame);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) { return (Map<String, Object>) value; }

    private void seen(Map<String, Object> entry) {
        String fp = Json.str(entry, "fp");
        byte[] pub = fp == null ? null : pins.get(fp);
        if (pub == null) return;
        String box = Json.str(entry, "box");
        if (!boxSigned(pub, box, Json.str(entry, "boxSig"))) return;
        boolean was = boxes.put(fp, box) != null;
        if (!was) events.presence(true);
    }

    static boolean boxSigned(byte[] pub, String box, String boxSig) {
        if (pub == null || box == null || boxSig == null || box.length() > 64 || boxSig.length() > 128) return false;
        try {
            return Crypto.fromB64url(box).length == 32 && Crypto.verify(pub, Crypto.utf8("wf-relay-v1|box|" + box), Crypto.fromB64url(boxSig));
        } catch (IllegalArgumentException error) { return false; }
    }

    @Override public void binary(byte[] data) {
        lastTraffic = System.currentTimeMillis();
        if (data.length < Tunnel.HEADER) return;
        int tid = ((data[0] & 0xff) << 24) | ((data[1] & 0xff) << 16) | ((data[2] & 0xff) << 8) | (data[3] & 0xff);
        Tunnel tunnel = tunnels.get(tid);
        if (tunnel != null) tunnel.receive(data);
    }

    @Override public void closed(String reason) {
        if (down) return;
        down = true;
        boxes.clear();
        ready.completeExceptionally(new IOException(reason));
        for (CompletableFuture<Map<String, Object>> future : new ArrayList<>(pending.values())) future.completeExceptionally(new IOException(reason));
        for (Tunnel tunnel : new ArrayList<>(tunnels.values())) tunnel.ended();
        tunnels.clear();
        events.down(reason);
    }

    /** For tests and the status line: this phone's fingerprint. */
    public String fingerprint() { return Crypto.fingerprint(publicKey); }
}
