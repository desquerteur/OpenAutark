// Owns: the dialing side of Autark's peer handshake (devices/handshake.ts – ephemeral X25519, both device keys sign the
// transcript, HKDF into one AES-256-GCM key per direction) and the encrypted JSON channel after it (devices/channel.ts:
// [u64 counter][ciphertext‖tag], counters strictly increasing), over one meeting-server tunnel.
// Never: accepts a PC key other than the paired one, or a text frame after the handshake.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

public final class PeerChannel implements Tunnel.Listener {
    public interface Listener {
        void message(Map<String, Object> message);
        void closed();
    }

    private static final int MAX_FRAME = 8 * 1024 * 1024;

    private final Tunnel tunnel;
    private final BlockingQueue<Object> handshake = new ArrayBlockingQueue<>(4);
    private byte[] sendKey;
    private byte[] receiveKey;
    private long sendCounter;
    private long receiveCounter = -1;
    private volatile boolean ready;
    private volatile boolean closed;
    private volatile Listener listener;

    private PeerChannel(Tunnel tunnel) { this.tunnel = tunnel; }

    /** Runs the handshake as the dialing side; the PC must prove the key `pcPublicKey`. */
    public static PeerChannel connect(Tunnel tunnel, byte[] seed, String deviceId, byte[] pcPublicKey, Listener listener) throws IOException {
        PeerChannel channel = new PeerChannel(tunnel);
        channel.listener = listener;
        tunnel.listen(channel);
        if (tunnel.isClosed()) throw new IOException("The tunnel closed.");
        byte[] pub = Crypto.ed25519Public(seed);
        byte[][] eph = Crypto.x25519Pair();
        byte[] nonce = Crypto.random(16);
        tunnel.sendText(Json.write(Json.map("t", "hello", "v", 1, "id", deviceId, "pub", Crypto.b64url(pub), "eph", Crypto.b64url(eph[1]), "n", Crypto.b64url(nonce))));
        Object reply;
        try { reply = channel.handshake.poll(15, TimeUnit.SECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); reply = null; }
        if (!(reply instanceof String)) { tunnel.close(); throw new IOException("Your PC did not answer the handshake."); }
        Map<String, Object> welcome;
        try { welcome = Json.object((String) reply); } catch (IllegalArgumentException error) { tunnel.close(); throw new IOException("Bad handshake answer."); }
        byte[] pubS = key32(Json.str(welcome, "pub"));
        byte[] ephS = key32(Json.str(welcome, "eph"));
        String sig = Json.str(welcome, "sig");
        if (!"welcome".equals(welcome.get("t")) || pubS == null || ephS == null || sig == null || !Arrays.equals(pubS, pcPublicKey)) {
            tunnel.close();
            throw new IOException("This is not the paired PC.");
        }
        byte[] hash = Crypto.sha256(Crypto.concat(Crypto.utf8("wf-peer-v1"), pub, eph[1], nonce, pubS, ephS));
        if (!Crypto.verify(pubS, Crypto.concat(Crypto.utf8("server"), hash), Crypto.fromB64url(sig))) {
            tunnel.close();
            throw new IOException("The PC's signature is not valid.");
        }
        byte[] okm = Crypto.hkdf(Crypto.x25519(eph[0], ephS), hash, "wf-peer-v1 keys", 64);
        channel.sendKey = Arrays.copyOfRange(okm, 0, 32);
        channel.receiveKey = Arrays.copyOfRange(okm, 32, 64);
        channel.ready = true;
        tunnel.sendText(Json.write(Json.map("t", "auth", "sig", Crypto.b64url(Crypto.sign(seed, Crypto.concat(Crypto.utf8("client"), hash))))));
        return channel;
    }

    private static byte[] key32(String value) {
        if (value == null) return null;
        try {
            byte[] raw = Crypto.fromB64url(value);
            return raw.length == 32 ? raw : null;
        } catch (IllegalArgumentException error) { return null; }
    }

    public boolean isClosed() { return closed; }

    public synchronized void send(Map<String, Object> message) {
        if (closed) return;
        byte[] body = Crypto.seal(sendKey, sendCounter, Json.write(message).getBytes(StandardCharsets.UTF_8));
        byte[] frame = new byte[8 + body.length];
        for (int i = 0; i < 8; i++) frame[i] = (byte) (sendCounter >>> (56 - 8 * i));
        System.arraycopy(body, 0, frame, 8, body.length);
        sendCounter++;
        tunnel.sendBinary(frame);
    }

    public void close() {
        tunnel.close();
        closed();
    }

    @Override public void message(byte[] data, boolean text) {
        if (!ready) {
            if (!text || data.length > 4096) { tunnel.close(); return; }
            handshake.offer(new String(data, StandardCharsets.UTF_8));
            return;
        }
        if (text || data.length < 24 || data.length > MAX_FRAME) { close(); return; }
        long counter = 0;
        for (int i = 0; i < 8; i++) counter = (counter << 8) | (data[i] & 0xff);
        if (counter <= receiveCounter) { close(); return; }
        byte[] plain = Crypto.open(receiveKey, counter, data, 8, data.length - 8);
        if (plain == null) { close(); return; }
        receiveCounter = counter;
        Map<String, Object> message;
        try { message = Json.object(new String(plain, StandardCharsets.UTF_8)); } catch (IllegalArgumentException error) { return; }
        Listener target = listener;
        if (target != null) target.message(message);
    }

    @Override public void closed() {
        if (closed) return;
        closed = true;
        handshake.offer(Boolean.FALSE);
        Listener target = listener;
        if (target != null) target.closed();
    }
}
