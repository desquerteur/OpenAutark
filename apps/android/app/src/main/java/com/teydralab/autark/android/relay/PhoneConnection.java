// Owns: pairing this phone with a PC by its Remote ID (B-078: the PC's own connect request with role "phone" – the same
// code on both screens, Accept on the PC, relay/RemotePair), and afterwards keeping one encrypted channel to the first PC
// of the company that is online through the meeting server – the phone belongs to the company, not to one PC: it pins
// every PC it knows (the list grows with phoneUse.attach, phoneuse/UseLink), reconnects with backoff (1 s … 60 s) after
// the server or the PC went away, a new tunnel as soon as one is back online there – and hands it to the local entrance
// (StreamProxy). Never: stores anything itself (the caller keeps Paired), polls the PC, or talks to a PC it does not pin.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class PhoneConnection implements StreamProxy.Channels {
    /** One PC of the company as the phone keeps it. */
    public static final class Pc {
        public final String fingerprint;
        public final String publicKey;
        public final String name;
        public final String deviceId;
        public Pc(String fingerprint, String publicKey, String name, String deviceId) {
            this.fingerprint = fingerprint; this.publicKey = publicKey; this.name = name == null ? "PC" : name; this.deviceId = deviceId == null ? "" : deviceId;
        }
    }

    /** What pairing gives the phone (kept in app-private storage by the caller). */
    public static final class Paired {
        public final String relay;
        public final String seed;
        public final String deviceId;
        public final String token;
        public final List<Pc> pcs;

        public Paired(String relay, String seed, String deviceId, String token, List<Pc> pcs) {
            this.relay = relay; this.seed = seed; this.deviceId = deviceId; this.token = token;
            this.pcs = Collections.unmodifiableList(new ArrayList<>(pcs));
        }

        /** The PCs as JSON (app storage). */
        public String pcsJson() {
            List<Object> out = new ArrayList<>();
            for (Pc pc : pcs) out.add(Json.map("fingerprint", pc.fingerprint, "publicKey", pc.publicKey, "name", pc.name, "deviceId", pc.deviceId));
            return Json.write(out);
        }

        /** PCs from storage JSON or from phoneUse.attach's `pcs` (keys fingerprint, publicKey, name, deviceId); bad rows are skipped. */
        public static List<Pc> pcsOf(Object value) {
            List<Pc> out = new ArrayList<>();
            if (!(value instanceof List)) return out;
            for (Object item : (List<?>) value) {
                if (!(item instanceof Map) || out.size() >= 16) continue;
                @SuppressWarnings("unchecked") Map<String, Object> row = (Map<String, Object>) item;
                String fp = Json.str(row, "fingerprint"), pub = Json.str(row, "publicKey");
                if (fp == null || pub == null || !fp.matches("[0-9a-f]{64}")) continue;
                try { if (!Crypto.fingerprint(Crypto.fromB64url(pub)).equals(fp)) continue; } catch (IllegalArgumentException error) { continue; }
                out.add(new Pc(fp, pub, Json.str(row, "name"), Json.str(row, "deviceId")));
            }
            return out;
        }

        public Paired withPcs(List<Pc> next) { return new Paired(relay, seed, deviceId, token, next); }
    }

    public interface Status { void changed(String text, boolean connected); }

    /** Shows the code while the person compares it on the PC. */
    public interface Codes { void code(String code, String pcName); }

    /** A pairing in progress; cancel() ends it (the PC hears it). */
    public static final class Pairing {
        volatile boolean cancelled;
        volatile RelayLink link;
        public void cancel() { cancelled = true; RelayLink current = link; if (current != null) current.close(); }
    }

    private static final long[] BACKOFF_MS = { 1_000, 2_000, 5_000, 15_000, 30_000, 60_000 };

    /** Pairs a new phone key with the PC under `remoteId`: the code shows through `codes`, then the person accepts on the PC. */
    public static Paired pair(String relay, String remoteId, String name, Pairing pairing, Codes codes) throws IOException {
        String id = remoteId.replaceAll("[\\s-]", "");
        if (!id.matches("\\d{9}")) throw new IOException("The Remote ID has nine digits.");
        byte[] seed = Crypto.newSeed();
        RelayLink link = new RelayLink(seed, Collections.emptyMap(), new RelayLink.Events() {
            @Override public void presence(boolean online) {}
            @Override public void down(String reason) {}
        });
        pairing.link = link;
        try {
            link.connect(relay);
            List<RelayLink.Found> found = link.find(id);
            if (found.isEmpty()) throw new IOException("No PC with this Remote ID is online at the meeting server. Is Autark running there and accepting connection requests?");
            RelayLink.Found pc = found.get(0);
            RemotePair exchange = new RemotePair((body, timeoutMs) -> link.request(pc, Json.map("op", "pair", "body", body), timeoutMs), seed, RemotePair.newDeviceId(), name);
            RemotePair.Asked asked = exchange.ask(id, pc.fingerprint);
            codes.code(asked.code, asked.pcName);
            RemotePair.Accepted accepted = exchange.await(asked, () -> pairing.cancelled);
            List<Pc> pcs = new ArrayList<>();
            pcs.add(new Pc(pc.fingerprint, Crypto.b64url(pc.publicKey), asked.pcName, asked.pcDeviceId));
            return new Paired(relay, Crypto.b64url(seed), accepted.deviceId, accepted.token, pcs);
        } finally {
            link.close();
        }
    }

    private volatile Paired paired;
    private final byte[] seed;
    private final Status status;
    private final Object lock = new Object();
    private StreamProxy proxy;
    private Thread worker;
    private RelayLink link;
    private PeerChannel channel;
    private volatile String channelPc;
    private volatile boolean stopped;
    private boolean wake;

    public PhoneConnection(Paired paired, Status status) {
        this.paired = paired;
        this.seed = Crypto.fromB64url(paired.seed);
        this.status = status;
    }

    /** Opens the local entrance (127.0.0.1:`port`, else any free port) and starts connecting; returns its origin. */
    public String start(int port, String gate) throws IOException {
        proxy = new StreamProxy(port, gate, this);
        worker = new Thread(this::run, "autark-connection");
        worker.setDaemon(true);
        worker.start();
        return proxy.origin();
    }

    public void stop() {
        stopped = true;
        nudge();
        synchronized (lock) {
            if (channel != null) channel.close();
            if (link != null) link.close();
        }
        if (proxy != null) proxy.close();
    }

    /** The app came to the front or the network changed: try now instead of after the pause. */
    public void nudge() {
        synchronized (lock) { wake = true; lock.notifyAll(); }
    }

    /** The company's PCs changed (phoneUse.attach): the server learns the new pins on the next registration. */
    public void updatePcs(List<Pc> pcs) {
        if (pcs.isEmpty()) return;
        Paired before = paired;
        if (before.pcsJson().equals(before.withPcs(pcs).pcsJson())) return;
        paired = before.withPcs(pcs);
        synchronized (lock) { if (link != null) link.close(); } // re-registers with every PC pinned; the open channel stays
        nudge();
    }

    public Paired paired() { return paired; }

    @Override public PeerChannel await(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (!stopped && (channel == null || channel.isClosed())) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) return null;
                wake = true;
                lock.notifyAll();
                try { lock.wait(Math.min(left, 1_000)); } catch (InterruptedException error) { Thread.currentThread().interrupt(); return null; }
            }
            return channel;
        }
    }

    private void run() {
        int attempt = 0;
        while (!stopped) {
            try {
                ensureLink();
                String fp = link.firstOnline();
                if (fp != null && (channel == null || channel.isClosed())) {
                    say("Connecting to " + nameOf(fp) + "…", false);
                    openChannel(fp);
                    attempt = 0;
                    say("Connected to " + nameOf(fp) + ".", true);
                } else if (fp == null) {
                    say("None of your PCs is online. Autark must be running on one of them.", false);
                }
                pause(15_000);
                if (link != null) link.checkAlive();
            } catch (IOException error) {
                say(error.getMessage() == null ? "Connection failed." : error.getMessage(), false);
                pause(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
            }
        }
    }

    private String nameOf(String fp) {
        for (Pc pc : paired.pcs) if (pc.fingerprint.equals(fp)) return pc.name;
        return "your PC";
    }

    private byte[] keyOf(String fp) {
        for (Pc pc : paired.pcs) if (pc.fingerprint.equals(fp)) return Crypto.fromB64url(pc.publicKey);
        return null;
    }

    private void ensureLink() throws IOException {
        if (link != null && link.isUp()) return;
        Map<String, byte[]> pins = new LinkedHashMap<>();
        for (Pc pc : paired.pcs) pins.put(pc.fingerprint, Crypto.fromB64url(pc.publicKey));
        RelayLink next = new RelayLink(seed, pins, new RelayLink.Events() {
            @Override public void presence(boolean online) { nudge(); }
            @Override public void down(String reason) { nudge(); }
        });
        say("Reaching the meeting server…", false);
        next.connect(paired.relay);
        synchronized (lock) { link = next; }
    }

    private void openChannel(String fp) throws IOException {
        byte[] pcPub = keyOf(fp);
        if (pcPub == null) throw new IOException("That PC is not one of yours.");
        Tunnel tunnel = link.open(fp);
        PeerChannel[] holder = new PeerChannel[1];
        PeerChannel next = PeerChannel.connect(tunnel, seed, paired.deviceId, pcPub, new PeerChannel.Listener() {
            @Override public void message(Map<String, Object> message) {
                PeerChannel current = holder[0];
                if (current != null) proxy.deliver(current, message);
            }
            @Override public void closed() {
                PeerChannel current = holder[0];
                if (current != null) proxy.channelClosed(current);
                nudge();
            }
        });
        holder[0] = next;
        synchronized (lock) { channel = next; channelPc = fp; lock.notifyAll(); }
        if (next.isClosed()) proxy.channelClosed(next);
    }

    private void pause(long ms) {
        synchronized (lock) {
            if (!wake && !stopped) {
                try { lock.wait(ms); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
            wake = false;
        }
    }

    private String lastStatus = "";

    private void say(String text, boolean connected) {
        if (text.equals(lastStatus)) return;
        lastStatus = text;
        status.changed(text, connected);
    }

    /** The PC this phone's channel goes to now (for the status line and tests). */
    public String pc() { return channelPc; }

    /** This phone's own fingerprint. */
    public String self() { return Crypto.fingerprint(Crypto.ed25519Public(seed)); }

    public int openStreams() { return proxy == null ? 0 : proxy.openStreams(); }
}
